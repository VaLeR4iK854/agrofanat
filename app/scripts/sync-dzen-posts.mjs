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
const CHANNEL_URL = `https://dzen.ru/id/${CHANNEL_ID}`;

const META_REGEX = /<meta\s+(?:property|name)=["'](og:[^"']+|twitter:[^"']+|article:[^"']+)["']\s+content=["']([^"']*)["']\s*\/?>/gi;
const JSON_LD_REGEX = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

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

function objectIdFromImageUrl(url) {
  if (!url) return null;
  const m = url.match(/pub_([a-f0-9]{24})_/i);
  return m ? m[1] : null;
}

function objectIdToDate(oid) {
  if (!oid || !/^[0-9a-f]{24}$/i.test(oid)) return null;
  const seconds = parseInt(oid.slice(0, 8), 16);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

function stripChannelPrefix(raw) {
  if (!raw) return "";
  return raw.replace(/^(?:Статья|Пост|Видео)\s+автора[^:]*?в\s+Дзене[^:]*:\s*/u, "").trim();
}

function firstSentence(text, maxLen = 120) {
  if (!text) return "";
  const trimmed = text.trim();
  const dotIdx = trimmed.search(/[.!?]\s/);
  if (dotIdx > 0 && dotIdx < maxLen + 40) return trimmed.slice(0, dotIdx + 1).trim();
  if (trimmed.length <= maxLen) return trimmed;
  const cut = trimmed.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim() + "…";
}

function splitFirstSentence(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { first: "", rest: "" };
  const m = trimmed.match(/^([\s\S]+?[.!?])\s+([\s\S]+)$/);
  if (!m) return { first: trimmed, rest: "" };
  return { first: m[1].trim(), rest: m[2].trim() };
}

async function fetchText(url, ua) {
  const res = await fetch(url, { headers: { "user-agent": ua, accept: "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function extractChannelPostUrls(channelHtml) {
  const urls = new Set();
  for (const match of channelHtml.matchAll(JSON_LD_REGEX)) {
    let block;
    try { block = JSON.parse(match[1]); } catch { continue; }
    if (block?.["@type"] !== "ItemList" || !Array.isArray(block.itemListElement)) continue;
    for (const el of block.itemListElement) {
      const item = el?.item ?? el;
      const url = item?.url;
      if (typeof url === "string" && /^https:\/\/dzen\.ru\/[ab]\/[^/?#]+$/.test(url)) {
        urls.add(url);
      }
    }
  }
  return [...urls];
}

async function loadPrevious() {
  try {
    const raw = await readFile(OUTPUT, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function enrichPost(url) {
  const html = await fetchText(url, OG_UA);
  const og = parseOgMeta(html);
  const image = og["og:image"] || null;
  const rawDescription = stripChannelPrefix(og["og:description"] || "");
  const isBrief = /\/b\//.test(url);

  let title;
  let description;
  if (isBrief) {
    // brief посты: og:title = имя канала, реальный текст только в og:description.
    // первое предложение становится заголовком, остальное - описанием. если первое
    // предложение слишком длинное - оно усекается под заголовок, описание пустое
    // чтобы не показывать одно и то же дважды.
    const { first, rest } = splitFirstSentence(rawDescription);
    if (first.length <= 110) {
      title = first;
      description = rest;
    } else {
      title = firstSentence(rawDescription, 110);
      description = "";
    }
  } else {
    title = (og["og:title"] || "").trim() || firstSentence(rawDescription, 110);
    description = firstSentence(rawDescription, 240);
  }

  const publishedAt =
    og["article:published_time"] ||
    objectIdToDate(objectIdFromImageUrl(image));

  const wordCount = rawDescription.trim().split(/\s+/).filter(Boolean).length;
  const readingMinutes = Math.max(1, Math.round(wordCount / 180));

  return {
    url,
    title: title.trim(),
    description: description.trim(),
    image,
    publishedAt,
    readingMinutes,
  };
}

async function main() {
  let channelHtml;
  try {
    channelHtml = await fetchText(CHANNEL_URL, OG_UA);
  } catch (err) {
    console.error("[sync-dzen] channel page fetch failed:", err.message);
    const prev = await loadPrevious();
    if (prev) { console.error("[sync-dzen] keeping previous snapshot"); process.exit(0); }
    process.exit(1);
  }

  const channelOg = parseOgMeta(channelHtml);
  const channelTitle = (channelOg["og:title"] || "АГРОФАНАТ").replace(/\s*\|\s*Дзен\s*$/iu, "").trim();

  const urls = extractChannelPostUrls(channelHtml);
  if (urls.length === 0) {
    console.error("[sync-dzen] no post URLs found in channel page");
    const prev = await loadPrevious();
    if (prev) process.exit(0);
    process.exit(1);
  }

  console.log(`[sync-dzen] found ${urls.length} post URLs in channel page`);

  const enriched = await Promise.allSettled(urls.map((u) => enrichPost(u)));
  const ok = enriched
    .filter((r) => r.status === "fulfilled" && r.value.title && r.value.url)
    .map((r) => r.value);

  if (ok.length === 0) {
    console.error("[sync-dzen] enrichment produced 0 valid posts");
    const prev = await loadPrevious();
    if (prev) process.exit(0);
    process.exit(1);
  }

  ok.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

  const payload = {
    channel: {
      id: CHANNEL_ID,
      title: channelTitle,
      url: CHANNEL_URL,
    },
    syncedAt: new Date().toISOString(),
    posts: ok.slice(0, LIMIT),
  };

  await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[sync-dzen] wrote ${payload.posts.length} posts (latest: ${payload.posts[0].publishedAt})`);
}

main().catch((err) => {
  console.error("[sync-dzen] fatal:", err);
  process.exit(1);
});
