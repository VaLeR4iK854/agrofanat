import type { APIRoute } from "astro";

const SITE = "https://agrofanat.ru";

const lines = [
  "# agrofanat - открытый дневник",
  "",
  "User-agent: *",
  "Allow: /",
  "",
  "# AI-краулеры разрешены - контент дневника открыт для AI-поисковиков",
  "User-agent: ClaudeBot",
  "Allow: /",
  "",
  "User-agent: GPTBot",
  "Allow: /",
  "",
  "User-agent: PerplexityBot",
  "Allow: /",
  "",
  "User-agent: Google-Extended",
  "Allow: /",
  "",
  "User-agent: anthropic-ai",
  "Allow: /",
  "",
  `Sitemap: ${SITE}/sitemap-index.xml`,
  "",
];

export const GET: APIRoute = () =>
  new Response(lines.join("\n"), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
