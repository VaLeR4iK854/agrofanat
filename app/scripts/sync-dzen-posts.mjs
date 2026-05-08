#!/usr/bin/env node
import { writeFile, readFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CHANNEL_ID = process.env.DZEN_CHANNEL_ID ?? "5d597768a2d6ed00ac2cd607";
const LIMIT = Number(process.env.DZEN_POSTS_LIMIT ?? 6);
const FEED_UA = "Mozilla/5.0 (compatible; AgrofanatBot/1.0; +https://agrofanat.ru)";
const OG_UA = "Mozilla/5.0 (compatible; Twitterbot/1.0)";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "../src/data/dzen-posts.json");

const FEED_URL = `https://dzen.ru/api/v3/launcher/more?country_code=ru&channel_id=${CHANNEL_ID}`;

const META_REGEX = /<meta\s+(?:property|name)=["'](og:[^"']+|twitter:[^"']+|article:[^"']+)["']\s+content=["']([^"']*)["']\s*\/?>/gi;

function parseOgMeta(html) {
  const meta = {};
  for (const match of html.matchAll(META_REGEX)) {
    const [, key, value] = match;
    if (!meta[key]) meta[key] = decodeHtmlEntities(value);
  }
  return meta;
}

function decodeHtmlEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#x27;/g, "'");
}

function objectIdToDate(oid) {
  if (!/^[0-9a-f]{24}$/i.test(oid)) return null;
  const seconds = parseInt(oid.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function cleanDescription(raw, channelTitle) {
  if (!raw) return "";
  const prefix = new RegExp(`^Статья автора[\\s«]+${channelTitle.trim()}[\\s»]+в Дзене\\s*[✍️]*\\s*:?\\s*`, "iu");
  return raw.replace(prefix, "").trim();
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { "user-agent": FEED_UA, accept: "application/json" } });
  if (!res.ok) throw new Error(`feed ${url}: HTTP ${res.status}`);
  return res.json();
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { "user-agent": OG_UA, accept: "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error(`og ${url}: HTTP ${res.status}`);
  return res.text();
}

async function loadPrevious() {
  try {
    const raw = await readFile(OUTPUT, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  let feed;
  try {
    feed = await fetchJson(FEED_URL);
  } catch (err) {
    console.error("[sync-dzen] feed fetch failed:", err.message);
    const prev = await loadPrevious();
    if (prev) {
      console.error("[sync-dzen] keeping previous snapshot");
      process.exit(0);
    }
    process.exit(1);
  }

  const items = (feed.items ?? []).filter((i) => i.share_link).slice(0, LIMIT);
  if (items.length === 0) {
    console.error("[sync-dzen] feed returned 0 posts");
    const prev = await loadPrevious();
    if (prev) process.exit(0);
    process.exit(1);
  }

  const channelTitle = (items[0].domain_title ?? "").trim();

  const enriched = await Promise.all(
    items.map(async (item) => {
      const url = item.share_link;
      let og = {};
      try {
        const html = await fetchHtml(url);
        og = parseOgMeta(html);
      } catch (err) {
        console.error(`[sync-dzen] og fetch failed for ${url}: ${err.message}`);
      }

      const title = og["og:title"] || item.title || "";
      const description = cleanDescription(og["og:description"] || item.text || "", channelTitle);
      const image = og["og:image"] || null;
      const publishedAt = og["article:published_time"] || objectIdToDate(item.publication_object_id);

      return {
        id: item.publication_object_id,
        url,
        title: title.trim(),
        description: description.trim(),
        image,
        publishedAt,
        readingMinutes: Math.max(1, Math.round((item.timeToReadSeconds ?? 60) / 60)),
        views: item.views ?? 0,
      };
    })
  );

  const ok = enriched.filter((p) => p.title && p.url);
  if (ok.length === 0) {
    console.error("[sync-dzen] no valid posts after enrichment");
    const prev = await loadPrevious();
    if (prev) process.exit(0);
    process.exit(1);
  }

  ok.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

  const payload = {
    channel: {
      id: CHANNEL_ID,
      title: channelTitle,
      url: `https://dzen.ru/id/${CHANNEL_ID}`,
    },
    syncedAt: new Date().toISOString(),
    posts: ok,
  };

  await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[sync-dzen] wrote ${ok.length} posts to ${OUTPUT}`);
}

main().catch((err) => {
  console.error("[sync-dzen] fatal:", err);
  process.exit(1);
});
