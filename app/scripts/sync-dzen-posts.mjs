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
const URL_IMAGE_REGEX = /"url":"(https:\/\/dzen\.ru\/[ab]\/[^"]+)","image":\{(?:[^{}]|\{[^{}]*\})*"link":"([^"]+)"/g;

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

function objectIdFromUrl(url) {
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

// разбиваем текст на заголовок + описание по первому знаку препинания после
// разумного минимума - получаем естественную "паузу" вместо обрыва по символам.
function splitTitleDescription(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { title: "", description: "" };

  // первая точка / восклицание / вопрос с пробелом - граница предложения
  const sentenceBreak = trimmed.match(/^([\s\S]{20,200}?[.!?])\s+([\s\S]+)$/u);
  if (sentenceBreak) {
    return { title: sentenceBreak[1].trim(), description: sentenceBreak[2].trim() };
  }

  // вторичные разделители: запятая, закрывающая скобка, тире
  const softBreak = trimmed.match(/^([\s\S]{30,90}?[,)\-—–])\s+([\s\S]+)$/u);
  if (softBreak) {
    const head = softBreak[1].trim().replace(/[,;:\-—–]+$/u, "").trim();
    return { title: head, description: softBreak[2].trim() };
  }

  // нет естественной границы - режем по слову на ~80 знаках
  if (trimmed.length <= 80) return { title: trimmed, description: "" };
  const cut = trimmed.slice(0, 80);
  const lastSpace = cut.lastIndexOf(" ");
  const head = (lastSpace > 30 ? cut.slice(0, lastSpace) : cut).trim();
  return { title: head, description: trimmed.slice(head.length).trim() };
}

async function fetchText(url, ua) {
  const res = await fetch(url, { headers: { "user-agent": ua, accept: "text/html" }, redirect: "follow" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function extractItemList(channelHtml) {
  const byUrl = new Map();
  for (const match of channelHtml.matchAll(JSON_LD_REGEX)) {
    let block;
    try { block = JSON.parse(match[1]); } catch { continue; }
    if (block?.["@type"] !== "ItemList" || !Array.isArray(block.itemListElement)) continue;
    for (const raw of block.itemListElement) {
      const item = raw?.item && typeof raw.item === "object" ? raw.item : raw;
      const url = item?.url;
      if (typeof url !== "string" || !/^https:\/\/dzen\.ru\/[ab]\/[^/?#]+$/.test(url)) continue;
      const existing = byUrl.get(url) ?? {};
      const merged = {
        url,
        name: existing.name || item.name || "",
        description: existing.description || item.description || "",
        image: existing.image || (typeof item.image === "string" ? item.image : item.image?.url) || "",
        datePublished: existing.datePublished || item.datePublished || "",
      };
      byUrl.set(url, merged);
    }
  }
  return [...byUrl.values()];
}

function extractBriefImageMap(channelHtml) {
  const map = new Map();
  for (const m of channelHtml.matchAll(URL_IMAGE_REGEX)) {
    if (!map.has(m[1])) map.set(m[1], m[2]);
  }
  return map;
}

// для brief: первое предложение/clause уже отрисовано на og:image (Дзен
// автогенерит preview с текстом). в карточке показываем только остаток,
// чтобы не повторять то что уже на обложке.
function skipFirstClause(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return "";
  const sentenceBreak = trimmed.match(/^[\s\S]{20,180}?[.!?]\s+([\s\S]+)$/u);
  if (sentenceBreak) return sentenceBreak[1].trim();
  const softBreak = trimmed.match(/^[\s\S]{30,90}?[,)\-—–]\s+([\s\S]+)$/u);
  if (softBreak) return softBreak[1].trim();
  return trimmed;
}

async function enrichBrief(url) {
  const html = await fetchText(url, OG_UA);
  const og = parseOgMeta(html);
  const fullText = stripChannelPrefix(og["og:description"] || "");
  const remainder = skipFirstClause(fullText);
  const { title, description } = splitTitleDescription(remainder);
  const image = og["og:image"] || null;
  const publishedAt =
    og["article:published_time"] ||
    objectIdToDate(objectIdFromUrl(image));
  const wordCount = fullText.trim().split(/\s+/).filter(Boolean).length;
  return {
    url,
    title,
    description,
    image,
    publishedAt,
    readingMinutes: Math.max(1, Math.round(wordCount / 180)),
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
  const items = extractItemList(channelHtml);
  const briefImageMap = extractBriefImageMap(channelHtml);

  if (items.length === 0) {
    console.error("[sync-dzen] no posts in channel JSON-LD");
    const prev = await loadPrevious();
    if (prev) process.exit(0);
    process.exit(1);
  }

  console.log(`[sync-dzen] found ${items.length} posts in JSON-LD`);

  const enriched = await Promise.allSettled(
    items.map(async (it) => {
      const isBrief = /\/b\//.test(it.url);
      if (!isBrief && it.name && it.description) {
        // article: всё уже в JSON-LD - не делаем лишний HTTP запрос
        return {
          url: it.url,
          title: it.name.trim(),
          description: it.description.trim(),
          image: it.image || null,
          publishedAt: it.datePublished || objectIdToDate(objectIdFromUrl(it.image)),
          readingMinutes: Math.max(1, Math.round(it.description.trim().split(/\s+/).length / 180)),
        };
      }
      // brief: первое предложение уже на og:image (Дзен генерит preview),
      // в карточке показываем продолжение текста чтобы не дублировать обложку
      return enrichBrief(it.url);
    })
  );

  const ok = enriched
    .filter((r) => r.status === "fulfilled" && r.value.url && (r.value.title || r.value.description))
    .map((r) => r.value);

  if (ok.length === 0) {
    console.error("[sync-dzen] enrichment produced 0 valid posts");
    const prev = await loadPrevious();
    if (prev) process.exit(0);
    process.exit(1);
  }

  ok.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

  const payload = {
    channel: { id: CHANNEL_ID, title: channelTitle, url: CHANNEL_URL },
    syncedAt: new Date().toISOString(),
    posts: ok.slice(0, LIMIT),
  };

  await writeFile(OUTPUT, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`[sync-dzen] wrote ${payload.posts.length} posts (latest: ${payload.posts[0].publishedAt})`);
}

async function loadPrevious() {
  try { return JSON.parse(await readFile(OUTPUT, "utf8")); } catch { return null; }
}

main().catch((err) => {
  console.error("[sync-dzen] fatal:", err);
  process.exit(1);
});
