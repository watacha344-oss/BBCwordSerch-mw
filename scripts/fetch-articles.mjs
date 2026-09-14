// Fetches several BBC RSS feeds, extracts articles, and merges new ones
// into data/articles.json (deduped by link, capped at MAX_ARTICLES).
// Run with: node scripts/fetch-articles.mjs   (from the repo root)

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';

const FEEDS = [
  { url: 'http://feeds.bbci.co.uk/news/rss.xml', tag: 'Top Stories' },
  { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', tag: 'World' },
  { url: 'http://feeds.bbci.co.uk/news/technology/rss.xml', tag: 'Technology' },
  { url: 'http://feeds.bbci.co.uk/news/business/rss.xml', tag: 'Business' },
  { url: 'http://feeds.bbci.co.uk/news/science_and_environment/rss.xml', tag: 'Science' },
];

const DATA_PATH = 'data/articles.json';
const MAX_ARTICLES = 1000;

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
    fetchedAt: new Date().toISOString(),
  }));
}

async function fetchFeed(feed) {
  const res = await fetch(feed.url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WordSearchBot/1.0)' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const xml = await res.text();
  return parseRss(xml, feed.tag);
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
  let newCount = 0;

  for (const feed of FEEDS) {
    try {
      const items = await fetchFeed(feed);
      for (const item of items) {
        if (item.link && item.title && !existingLinks.has(item.link)) {
          existing.push(item);
          existingLinks.add(item.link);
          newCount++;
        }
      }
      console.log(`${feed.tag}: fetched ${items.length} item(s)`);
    } catch (e) {
      console.error(`${feed.tag}: failed - ${e.message}`);
    }
  }

  existing.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
  if (existing.length > MAX_ARTICLES) existing = existing.slice(0, MAX_ARTICLES);

  writeFileSync(DATA_PATH, JSON.stringify(existing, null, 2));
  console.log(`Done. ${newCount} new article(s) added. Total stored: ${existing.length}`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
