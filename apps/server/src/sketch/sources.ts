// ─────────────────────────────────────────────────────────
// Reference resources for sketches.
//
//   1. A local folder of SVGs you provide (resources/sketches/)
//   2. Open-licensed online libraries (Wikimedia Commons), only
//      from allowlisted hosts, only freely licensed files
//      (CC0 / public domain / CC BY / CC BY-SA), with size and
//      time limits. Attribution travels with the sketch.
//
// Every candidate goes through the same converter and quality
// gate; the one that best covers the requested parts wins.
// ─────────────────────────────────────────────────────────

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { Template } from "../diagram/templates.js";
import { extractSketch } from "./extract.js";
import { coverage, subjectKey, subjectTitle, subjectWords, type Requested } from "./match.js";
import { MAX_SVG_BYTES, readSvg } from "./svg.js";

export interface SketchSource {
  kind: "local" | "commons" | "ai";
  /** Human-readable credit line, e.g. "Lars Chittka; Axel Brockmann — CC BY 2.5". */
  credit?: string;
  title?: string;
  url?: string;
  author?: string;
  license?: string;
}

export interface Found {
  title: string;
  drawing: Omit<Template, "id" | "title">;
  source: SketchSource;
  /** Requested parts it covers. */
  score: number;
}

const SVG_FILE = /\.svg$/i;

// ── Local folder ───────────────────────────────────────

interface LocalMeta { title?: string; aliases?: string[]; author?: string; license?: string; source?: string }

/** SVGs in the local folder whose file name (or sidecar aliases) match the subject. */
export async function findLocal(slug: string, requested: Requested[]): Promise<Found | null> {
  const dir = config.sketch.dir;
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => SVG_FILE.test(f));
  } catch {
    return null; // no folder: nothing provided
  }
  const key = subjectKey(slug);
  let best: Found | null = null;
  for (const file of files) {
    const base = file.replace(SVG_FILE, "");
    const meta = await readMeta(path.join(dir, `${base}.json`));
    const keys = [base, ...(meta.aliases ?? [])].map(subjectKey);
    if (!keys.includes(key)) continue;
    try {
      const stat = await fs.stat(path.join(dir, file));
      if (stat.size > MAX_SVG_BYTES) continue;
      const result = extractSketch(readSvg(await fs.readFile(path.join(dir, file), "utf8")));
      if (!result) { console.warn(`🖍  local sketch ${file}: no usable labelled drawing`); continue; }
      const license = meta.license;
      const found: Found = {
        title: meta.title ?? subjectWords(base),
        drawing: result.template,
        source: {
          kind: "local", title: file, author: meta.author, license, url: meta.source,
          credit: meta.author ? `${meta.author}${license ? ` — ${license}` : ""}` : undefined,
        },
        score: coverage(requested, result.template.parts),
      };
      if (!best || found.score > best.score) best = found;
    } catch (err) {
      console.warn(`🖍  local sketch ${file} unreadable: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return best;
}

async function readMeta(file: string): Promise<LocalMeta> {
  try {
    const v = JSON.parse(await fs.readFile(file, "utf8")) as LocalMeta;
    return {
      title: typeof v.title === "string" ? v.title.slice(0, 80) : undefined,
      aliases: Array.isArray(v.aliases) ? v.aliases.filter((a): a is string => typeof a === "string").slice(0, 20) : undefined,
      author: typeof v.author === "string" ? v.author.slice(0, 120) : undefined,
      license: typeof v.license === "string" ? v.license.slice(0, 40) : undefined,
      source: typeof v.source === "string" && /^https:\/\//.test(v.source) ? v.source.slice(0, 300) : undefined,
    };
  } catch {
    return {};
  }
}

// ── Safe fetching ──────────────────────────────────────

class FetchError extends Error {}

function allowed(url: URL): boolean {
  return url.protocol === "https:" && config.sketch.allowHosts.includes(url.hostname.toLowerCase());
}

/** GET from an allowlisted host: no cross-host redirects, size cap, timeout, cancellable. */
async function safeGet(raw: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  let url = new URL(raw);
  for (let hop = 0; hop < 3; hop++) {
    if (!allowed(url)) throw new FetchError(`host not allowed: ${url.hostname}`);
    const get = () => fetch(url, {
      redirect: "manual",
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.sketch.fetchTimeoutMs)]),
      headers: { "User-Agent": config.sketch.userAgent, Accept: "application/json, image/svg+xml;q=0.9, */*;q=0.1" },
    });
    let res = await get();
    if (res.status === 429) {
      // Throttled: one polite retry after the advertised delay (capped).
      const wait = Math.min(4000, Math.max(800, Number(res.headers.get("retry-after") ?? 1) * 1000));
      await new Promise((r) => setTimeout(r, wait));
      if (signal.aborted) throw new FetchError("aborted");
      res = await get();
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url);
      continue;
    }
    if (!res.ok || !res.body) throw new FetchError(`HTTP ${res.status}`);
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new FetchError("too large");
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new FetchError("too large"); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new FetchError("too many redirects");
}

// ── Wikimedia Commons ──────────────────────────────────

const FREE_LICENSE = /^(cc0|public domain|pd\b|pd-|cc[- ]by(-sa)?[- ]\d(\.\d)?)/i;
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();

interface CommonsPage {
  title: string;
  index?: number;
  imageinfo?: Array<{ url: string; size: number; descriptionurl?: string; extmetadata?: Record<string, { value: string }> }>;
}

/**
 * Originals and English copies first; translated copies ("…_cs.svg", "…-mr.svg" — lowercase codes,
 * so "…Human Ear.svg" is not mistaken for one) next; copies without text labels last.
 */
export function candidateRank(title: string): number {
  if (/\b(blank|unlabel+ed|no[ _-]?text|numbers?|numbered|empty)\b/i.test(title)) return 2;
  const m = /[ _-]([a-z]{2,3})(?:[ _-]\d+)?\.svg$/.exec(title);
  return !m || m[1] === "en" ? 0 : 1;
}

export async function findCommons(slug: string, requested: Requested[], signal: AbortSignal): Promise<Found | null> {
  if (!config.sketch.online) return null;
  const words = subjectWords(slug);
  const queries = [`${words} diagram`, words];
  const seen = new Set<string>();
  const pages: CommonsPage[] = [];
  for (const q of queries) {
    const api = new URL("https://commons.wikimedia.org/w/api.php");
    api.search = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", generator: "search", gsrnamespace: "6", gsrlimit: "12",
      gsrsearch: `${q} filemime:image/svg+xml`, prop: "imageinfo", iiprop: "url|size|extmetadata",
      iiextmetadatafilter: "LicenseShortName|Artist|AttributionRequired",
    }).toString();
    try {
      const body = JSON.parse(await safeGet(api.toString(), 2_000_000, signal)) as { query?: { pages?: CommonsPage[] } };
      for (const p of (body.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
        if (!seen.has(p.title)) { seen.add(p.title); pages.push(p); }
      }
    } catch (err) {
      if (signal.aborted) throw err;
      console.warn(`🖍  commons search failed: ${(err as Error).message.slice(0, 120)}`);
    }
    if (pages.length >= 6) break;
  }

  const candidates = pages
    .map((p) => ({ p, info: p.imageinfo?.[0] }))
    .filter(({ info }) => info && info.size <= config.sketch.maxDownloadBytes && /\.svg(\?|$)/i.test(info.url))
    .filter(({ info }) => FREE_LICENSE.test(info!.extmetadata?.LicenseShortName?.value ?? ""))
    .sort((a, b) => candidateRank(a.p.title) - candidateRank(b.p.title))
    .slice(0, config.sketch.maxCandidates);

  let best: Found | null = null;
  const deadline = Date.now() + config.sketch.budgetMs;
  for (const { p, info } of candidates) {
    if (Date.now() > deadline || signal.aborted) break;
    try {
      const url = info!.url.split("?")[0];
      const svg = await safeGet(url, config.sketch.maxDownloadBytes, signal);
      const result = extractSketch(readSvg(svg));
      if (!result) continue;
      const score = coverage(requested, result.template.parts);
      const author = stripHtml(info!.extmetadata?.Artist?.value ?? "").slice(0, 120) || undefined;
      const license = info!.extmetadata?.LicenseShortName?.value;
      const title = p.title.replace(/^File:/, "").replace(/\.svg$/i, "");
      const found: Found = {
        title: subjectTitle(slug),
        drawing: result.template,
        source: {
          kind: "commons", title, url: info!.descriptionurl ?? url, author, license,
          credit: `“${title}”${author ? ` by ${author}` : ""}, ${license} (Wikimedia Commons)`,
        },
        score,
      };
      console.log(`🖍  commons candidate "${title}": ${result.template.parts.length} parts, covers ${score}/${requested.length}`);
      if (!best || score > best.score || (score === best.score && found.drawing.parts.length > best.drawing.parts.length)) best = found;
      if (requested.length && score >= Math.ceil(requested.length * 0.8)) break; // good enough
    } catch (err) {
      if (signal.aborted) throw err;
      console.warn(`🖍  commons candidate "${p.title}" skipped: ${(err as Error).message.slice(0, 120)}`);
    }
  }
  return best;
}
