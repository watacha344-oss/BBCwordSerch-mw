// Fetches many BBC RSS feeds, then fetches each NEW article's full page
// to extract the article body (not just the short RSS summary), and merges
// everything into data/articles.json (deduped by link, capped at MAX_ARTICLES).
// Run with: node scripts/fetch-articles.mjs   (from the repo root)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const FEEDS = [
  { url: 'http://feeds.bbci.co.uk/news/rss.xml', tag: 'Top Stories' },
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', tag: 'World' },
  { url: 'http://feeds.bbci.co.uk/news/uk/rss.xml', tag: 'UK' },
  { url: 'http://feeds.bbci.co.uk/news/politics/rss.xml', tag: 'Politics' },
  { url: 'http://feeds.bbci.co.uk/news/business/rss.xml', tag: 'Business' },
  { url: 'http://feeds.bbci.co.uk/news/technology/rss.xml', tag: 'Technology' },
  { url: 'http://feeds.bbci.co.uk/news/science_and_environment/rss.xml', tag: 'Science' },
  { url: 'http://feeds.bbci.co.uk/news/health/rss.xml', tag: 'Health' },
  { url: 'http://feeds.bbci.co.uk/news/education/rss.xml', tag: 'Education' },
  { url: 'http://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml', tag: 'Entertainment' },
];

const DATA_PATH = 'data/articles.json';
const MAX_ARTICLES = 3000;
const MAX_NEW_PER_RUN = 200;   // safety cap so one run can't fetch forever
const BODY_CHAR_LIMIT = 6000;  // per-article cap so the JSON file stays reasonable
const REQUEST_DELAY_MS = 250;  // be polite to BBC's servers between article fetches
const UA = 'Mozilla/5.0 (compatible; WordSearchBot/1.0)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripHtml(str) {
  return (str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? stripHtml(m[1]) : '';
}

function parseRss(xml, tagName) {
  const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  return items.map((block) => ({
    title: extractTag(block, 'title'),
    description: extractTag(block, 'description'),
    link: extractTag(block, 'link'),
    pubDate: extractTag(block, 'pubDate'),
    tag: tagName,
  }));
}

async function fetchText(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFeed(feed) {
  const xml = await fetchText(feed.url);
  return parseRss(xml, feed.tag);
}

// Pull the readable body text out of a BBC article page. BBC doesn't need a
// CORS proxy here because this runs server-side (GitHub Actions), not in a
// browser, so a plain fetch works.
async function fetchArticleBody(link) {
  const html = await fetchText(link);
  const cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const paragraphs = (cleaned.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) || [])
    .map((p) => stripHtml(p))
    .filter((p) => p.split(' ').length >= 5); // drop short nav/caption fragments
  let body = paragraphs.join(' ');
  if (body.length > BODY_CHAR_LIMIT) body = body.slice(0, BODY_CHAR_LIMIT);
  return body;
}

async function main() {
  mkdirSync('data', { recursive: true });

  let existing = [];
  if (existsSync(DATA_PATH)) {
    try {
      existing = JSON.parse(readFileSync(DATA_PATH, 'utf-8'));
    } catch {
      existing = [];
    }
  }
  const existingLinks = new Set(existing.map((a) => a.link));

  // 1) Pull all feeds and collect items not already stored (dedup across feeds too)
  const candidateMap = new Map(); // link -> item
  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      for (const item of items) {
        if (item.link && item.title && !existingLinks.has(item.link) && !candidateMap.has(item.link)) {
          candidateMap.set(item.link, item);
        }
      }
      console.log(`${feed.tag}: fetched ${items.length} item(s) from feed`);
    } catch (e) {
      console.error(`${feed.tag}: feed failed - ${e.message}`);
    }
  }

  const candidates = Array.from(candidateMap.values()).slice(0, MAX_NEW_PER_RUN);
  console.log(`New candidates this run: ${candidates.length}`);

  // 2) Fetch full body text for each new article
  let addedCount = 0;
  for (const item of candidates) {
    let body = '';
    try {
      body = await fetchArticleBody(item.link);
    } catch (e) {
      console.error(`Body fetch failed for ${item.link}: ${e.message}`);
    }
    existing.push({
      title: item.title,
      description: item.description,
      body,
      link: item.link,
      pubDate: item.pubDate,
      tag: item.tag,
      fetchedAt: new Date().toISOString(),
    });
    addedCount++;
    await sleep(REQUEST_DELAY_MS);
  }

  existing.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  if (existing.length > MAX_ARTICLES) existing = existing.slice(0, MAX_ARTICLES);

  writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2));
  console.log(`Done. ${addedCount} new article(s) added (with full body). Total stored: ${existing.length}`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
