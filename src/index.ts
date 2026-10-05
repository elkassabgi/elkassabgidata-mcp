// ---------------------------------------------------------------------------
// ElkassabgiData MCP server — AI-native access to the family of free
// research-grade data libraries, ONE server for all of them:
//   * Econ Data Library  (econdatalibrary.com)  — billions of economic series
//   * HF Data Library    (hfdatalibrary.com)    — 1-minute US equity bars
//   * IP Data Library    (ipdatalibrary.com)    — patent & innovation measures
//
// Design rules (mirroring the sites exactly):
//   * BROWSE IS FREE, DOWNLOADS ARE KEYED: search/metadata/freshness/status
//     tools work without a key; data tools require the free ElkassabgiData
//     API key (ONE account across every library, current and future).
//   * HONESTY IS LAW: upstream error messages (401/404/429/501/502) are
//     relayed verbatim — they are designed to be actionable. Data caveats
//     (coverage, licensing, freshness) ship WITH the data, and
//     truncation is always disclosed, never silent.
//   * The user's key passes through per-request (header or ?api_key= on the
//     configured URL) into ctx.props; it is never stored, logged, or echoed
//     back into the conversation.
// ---------------------------------------------------------------------------

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
  MCP_OBJECT: DurableObjectNamespace;
}
type Props = { apiKey: string | null };

const ECON = "https://econdl-api.elkassabgi.workers.dev";
const IP_API = "https://api.ipdatalibrary.com";
const HF_API = "https://api.hfdatalibrary.com";
// hf sign-ups are paused (2026-10-03); econ's account page creates the same family account.
const ACCOUNT_URL = "https://econdatalibrary.com/account";
const MAX_CHARS = 45_000;          // per-tool-response ceiling (context-friendly)
// R615: an unfiltered large object is served as the STORED gzip bytes (a passthrough). Reading
// one whole costs this isolate its 128 MB memory limit - and the isolate is the McpAgent Durable
// Object, so the user's whole session dies with it. The MCP never wants more than max_rows<=2000
// rows anyway: refuse the passthrough at the header, before a byte of body is read, and tell the
// caller to ask for a date window (which makes the server filter, and send a verifiable body).
// 1 MiB stored, not 4: at the fleet's largest measured compression ratio (37.5x, the
// worker's own MAX_RATIO) 4 MiB of stored gzip is 157 MB of text, and a real flat-value
// monthly series measured 4.00 MiB stored -> 77.3 MB of text, whose peak heap through this
// tool's line pipeline (measured 2.81x the text) is ~217 MB against a 128 MB limit (R620).
const MCP_MAX_PASSTHROUGH_BYTES = 1024 * 1024;
// The worker refuses server-side filtering above this stored size (4 GiB / 37.5), so above it
// a date window is not a way out of the size refusal - it is a second refusal.
const FILTER_MAX_STORED_BYTES = 114_532_461;
// The hard ceiling on TEXT this tool will hold, whatever shape it arrived in.
const MCP_MAX_TEXT_BYTES = 8 * 1024 * 1024;
// JSON endpoints that grow with the fleet rather than with a caller-supplied limit.
const MCP_MAX_JSON_BYTES = 4 * 1024 * 1024;

/**
 * JSON body with the same ceiling as the CSV read, for the endpoints whose size grows with
 * the fleet rather than with a caller-supplied limit (R622). Returns null when the cap is hit
 * or the text does not parse, so the caller can say so rather than throw inside a tool.
 */
async function jsonCapped<T>(r: Response, cap: number = MCP_MAX_JSON_BYTES): Promise<T | null> {
  const { text: t, capped } = await readCapped(r, cap);
  if (capped) return null;
  try { return JSON.parse(t) as T; } catch { return null; }
}

/** Drop a response body without reading it. */
async function discard(r: Response) {
  try { await r.body?.cancel(); } catch { /* the body is being discarded anyway */ }
}

/**
 * Read a response body as text, stopping at `cap` bytes.
 *
 * `r.text()` has no ceiling: it reads whatever arrives, and the isolate dies with the
 * McpAgent Durable Object - taking the user's session - somewhere past 128 MB. EVERY SHAPE OF
 * THE CSV READ goes through here, because the shape that can be measured up front (the gzip
 * passthrough, which declares content-length) is not the shape that gets large by surprise (a
 * wide date window on the inflate path, which declares nothing). The JSON endpoints are read
 * separately: most are server-clamped, and the two that grow with the fleet use jsonCapped.
 *
 * Cost of the cap, measured in a real isolate at 8 MiB: +9.3 MB after the read and +38.6 MB
 * after this tool's split/map/filter/slice pipeline for ASCII (4.61x the capped bytes), and
 * +11.1 / +48.6 MB (5.79x) when one non-Latin-1 character forces V8's two-byte string. So the
 * margin against 128 MB is ~2.6x, and two concurrent tool calls in one Durable Object halve it.
 */
async function readCapped(r: Response, cap: number): Promise<{ text: string; capped: boolean }> {
  const body = r.body;
  if (!body) return { text: "", capped: false };
  const reader = body.getReader();
  const dec = new TextDecoder();
  let out = "";
  let seen = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > cap) {
        try { await reader.cancel(); } catch { /* already going away */ }
        return { text: out, capped: true };
      }
      out += dec.decode(value, { stream: true });
    }
    out += dec.decode();
  } finally {
    try { reader.releaseLock(); } catch { /* the reader is done with */ }
  }
  return { text: out, capped: false };
}
const UPSTREAM_TIMEOUT_MS = 25_000;
// A whole-source bundle manifest does one catalogue read per series (api bundle.ts), ~13-16 ms each:
// 1,035 series took 13.0 s and 3,822 took 59.8 s (AR-186). Above this the tool refuses before
// asking, instead of timing out after the server has done the work.
const BUNDLE_SOURCE_MAX = 1000;

// ── upstream fetch with timeout + one retry on transient failure ────────────
// `retry` is false for a request whose cost grows with its input (a bundle manifest): a timeout
// there is deterministic, so a retry doubles the server's work and the wait and changes nothing
// (AR-186: a 3,822-series manifest timed out twice, 50 s, then "The operation was aborted").
async function upstream(url: string, apiKey?: string | null, retry: boolean = true): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "elkassabgidata-mcp", "X-Elkassabgi-Client": "mcp" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(t);
      if (r.status >= 500 && attempt === 0 && retry) continue;   // one retry on 5xx
      return r;
    } catch (e) {
      clearTimeout(t);
      if (attempt === 0 && retry) continue;                       // one retry on abort/network
      throw e;
    }
  }
}

function text(s: string) {
  if (s.length > MAX_CHARS) {
    s = s.slice(0, MAX_CHARS) +
      "\n\n[Output truncated at the response ceiling — narrow the query " +
      "(date range, limit, source filter) for complete results.]";
  }
  return { content: [{ type: "text" as const, text: s }] };
}

async function relayError(r: Response, what: string) {
  let detail = "";
  try {
    const j = await r.json() as { error?: string; detail?: string };
    detail = `${j.error ?? ""}${j.detail ? " — " + j.detail : ""}`;
  } catch { /* non-JSON body */ }
  return text(`${what}: upstream returned HTTP ${r.status}${detail ? ` (${detail})` : ""}`);
}

// How to get and configure the key - true wherever it is shown.
const KEY_HOWTO =
  "the free ElkassabgiData API key - ONE account for every Elkassabgi data library " +
  "(hfdatalibrary.com, econdatalibrary.com, ipdatalibrary.com, and future ones). If you " +
  `registered on any of them, that key works here. Get one free at ${ACCOUNT_URL} , then add it ` +
  "to this MCP server's configuration (Authorization: Bearer <key>, X-API-Key header, or " +
  "?api_key=<key> appended to the server URL).";
const NO_KEY_MSG = "This tool downloads data, which requires " + KEY_HOWTO;
// for a tool that is free itself but hands out URLs that need the key (AR-186 #6)
const KEY_FOR_URLS_MSG = "Downloading these URLs requires " + KEY_HOWTO;

// ── the 25 academic variables, VERBATIM from the published dictionary ───────
const VARIABLES_25 = `The 25 pre-computed academic variables (per ticker, per trading day, raw & clean; source: hfdatalibrary.com/pages/dictionary):
1. Realized variance (5-min) — RV = Σ r² using 5-minute sampled returns
2. Realized variance (1-min) — RV = Σ r² using all 1-minute returns
3. Bipower variation — BV = (π/2) Σ |r_i||r_(i-1)| (Barndorff-Nielsen and Shephard 2004)
4. Parkinson range volatility — σ² = (1/4 ln 2)(ln H/L)² (Parkinson 1980)
5. Rogers-Satchell volatility — RS = ln(H/O)·ln(H/C) + ln(L/O)·ln(L/C) — drift-independent per-day core of Yang-Zhang (Rogers & Satchell 1991; Yang and Zhang 2000)
6. Roll implied spread — S = 2√(−Cov(r_t, r_(t-1))) in basis points (Roll 1984)
7. Corwin-Schultz spread — high-low spread estimator (Corwin and Schultz 2012)
8. AC(1) — first-order autocorrelation of 1-minute log returns
9. VR(5) — variance ratio: Var(5-min returns) / [5 × Var(1-min returns)]
10. VR(10) — variance ratio: Var(10-min returns) / [10 × Var(1-min returns)]
11. BNS z-statistic — z = √M(1 − BV/RV)/√(θ·max(1, TQ/BV²)), θ = π²/4 + π − 5, TQ = tri-power quarticity, on 5-minute returns (Barndorff-Nielsen & Shephard 2006; Huang & Tauchen 2005)
12. BNS jump (1%) — indicator: 1 if z > 2.326
13. BNS jump (5%) — indicator: 1 if z > 1.645
14. Amihud illiquidity — |r_daily| / dollar volume (Amihud 2002)
15. Daily dollar volume — Σ (Close_i × Volume_i)
16. Daily share volume — Σ Volume_i
17. Traded bars — number of 1-minute bars with actual trading (Volume > 0)
18. Gap rate — fraction of the daily session grid (390 bars, or fewer on early-close half-days) with no trade
19. Observed bars — number of bars with actual trades
20. Longest gap — maximum consecutive missing bars in the day
21. Max bars since last trade — largest gap between consecutive observed bars
22. Open-to-close return — ln(Close_last / Open_first)
23. Overnight return — ln(Open_today / Close_yesterday)
24. Daily high-low range — ln(High_max / Low_min)
25. Intraday return std — standard deviation of 1-minute log returns`;

// The HF pause sentence is time-bound: when hf lifts DATA_PAUSED / HF_SIGNUPS_PAUSED, edit it (and the
// get_hf_download_link note and the family-status HF line) and redeploy this worker.
const HONESTY_CHARTER = `ElkassabgiData honesty charter (relay these caveats with any analysis):
• HF data is IEX Exchange HIST only, 2022-03-07 onward: IEX is ~2-3% of consolidated volume, so volumes and some prices differ from the full tape. The ticker list is not point-in-time: names are not added or removed automatically as companies list or delist. HF downloads and new HF sign-ups are paused while the dataset is restructured.
• 1-minute bars are NOT tick data: no quotes, no trade-level timestamps, no order book.
• Econ licensing is PER SOURCE: most are CC-BY-class (attribution required); a substantial share are non-commercial (commercial_ok=false in the metadata), and some forbid modification (no_modify). Data whose licence does not allow redistribution is not served or offered for download. The license ships in every series' metadata — honor it.
• IP measures are computed from USPTO data (public domain, via PatentsView bulk tables); they are not the official USPTO record. Forward-citation counts are right-censored for recent patents.
• Freshness is never fabricated: a series' date advances only when observations were actually fetched; failures surface as stale flags, not silent gaps (see get_data_freshness).
• Missing values stay missing: nothing is interpolated, forward-filled, or invented anywhere in the pipeline.`;

// ── the MCP agent ────────────────────────────────────────────────────────────
export class ElkassabgiDataMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "elkassabgidata",
    version: "1.1.0",
  });

  private key(): string | null {
    return this.props?.apiKey ?? null;
  }

  async init() {
    const s = this.server;

    // ═════════════════ ECON DATA LIBRARY ═════════════════
    s.registerTool("search_econ_series", {
      title: "Search Economic Series",
      description:
        "Search the Econ Data Library catalog (billions of series from hundreds of sources: " +
        "national accounts, prices, trade, labor, energy, markets…). Free, no " +
        "key needed. Returns series ids usable with get_econ_series. Page with offset; " +
        "lang returns source-official translated titles where the publisher provides them.",
      inputSchema: {
        query: z.string().min(2).describe("Free-text search, e.g. 'germany inflation' or 'GDP per capita'"),
        source: z.string().optional().describe("Restrict to one source id, e.g. 'worldbank', 'ecb', 'imf_weo'"),
        limit: z.number().int().min(1).max(50).default(15),
        offset: z.number().int().min(0).default(0)
          .describe("Skip this many results (paging). The API caps how deep it pages and says so if exceeded."),
        lang: z.enum(["en", "ar", "es", "fr", "ru", "zh"]).default("en")
          .describe("Title language. Only official translations are shown; a title without one stays in English."),
      },
      annotations: { readOnlyHint: true },
    }, async ({ query, source, limit, offset, lang }) => {
      const u = new URL(`${ECON}/v1/catalog`);
      u.searchParams.set("q", query);
      u.searchParams.set("limit", String(limit));
      if (offset) u.searchParams.set("offset", String(offset));
      if (lang && lang !== "en") u.searchParams.set("lang", lang);
      if (source) u.searchParams.set("source", source);
      const r = await upstream(u.toString());
      if (!r.ok) return relayError(r, "search_econ_series");
      const d = await r.json() as { total: number; results: Array<Record<string, unknown>> };
      const lines = (d.results ?? []).map((x) =>
        `${x.series_id}\n   ${x.title ?? "(untitled)"} [${x.frequency ?? "?"}, ${x.geography ?? "?"}${x.unit ? ", " + x.unit : ""}] ${x.start_date ?? "?"}→${x.end_date ?? "?"} · license:${x.license_id ?? "?"}`);
      return text(
        `${d.total?.toLocaleString?.() ?? "?"} series match "${query}"${source ? ` in ${source}` : ""}. ` +
        (lines.length === 0 && offset
          ? `No results from result ${offset + 1}: that is past the end of the matches.\n\n`
          : `Showing ${lines.length}${offset ? ` from result ${offset + 1}` : ""}:\n\n`) +
        lines.join("\n") +
        `\n\nFetch data with get_econ_series(series_id). Metadata + citation with get_econ_series_metadata.`);
    });

    s.registerTool("get_econ_series", {
      title: "Download Economic Series",
      description:
        "Download an economic time series as rows (long format: date, value) " +
        "with its citation and license. REQUIRES the free ElkassabgiData API " +
        "key. Use date_from/date_to to window long series.",
      inputSchema: {
        series_id: z.string().describe("Exact catalog id from search_econ_series, e.g. 'worldbank:NY.GDP.MKTP.CD:DEU'"),
        date_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        date_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        max_rows: z.number().int().min(10).max(2000).default(400),
      },
      annotations: { readOnlyHint: true },
    }, async ({ series_id, date_from, date_to, max_rows }) => {
      const key = this.key();
      if (!key) return text(NO_KEY_MSG);
      const enc = encodeURIComponent(series_id);
      // metadata first (free): citation, license, coverage
      let metaBlock = "";
      try {
        const mr = await upstream(`${ECON}/v1/series/${enc}.metadata.json`);
        if (mr.ok) {
          const m = await mr.json() as Record<string, any>;
          metaBlock =
            `${m.title ?? series_id} [${m.frequency ?? "?"}, ${m.geography ?? "?"}${m.unit ? ", " + m.unit : ""}]\n` +
            `License: ${m.license?.name ?? m.license?.id ?? "see metadata"}` +
            `${m.license?.commercial_ok === false ? " (NON-COMMERCIAL — honor it)" : ""}\n` +
            `${m.attribution ? "Attribution: " + m.attribution + "\n" : ""}`;
        }
      } catch { /* metadata is best-effort; data call decides success */ }
      const du = new URL(`${ECON}/v1/series/${enc}.csv`);
      du.searchParams.set("raw", "1"); // bare CSV; the MCP prepends its own citation metaBlock
      if (date_from) du.searchParams.set("from", date_from);
      if (date_to) du.searchParams.set("to", date_to);
      const r = await upstream(du.toString(), key);
      if (!r.ok) return relayError(r, "get_econ_series");
      // Decide on the HEADERS, before the body is read (R615).
      const hasLen = r.headers.get("content-length") !== null;
      const passthrough = r.headers.get("x-econdl-citation-omitted") !== null;
      if (passthrough) {
        const stored = Number(r.headers.get("content-length") ?? "");
        if (!hasLen || !Number.isFinite(stored)) {
          await discard(r);
          return { content: [{ type: "text", text: `${series_id}: the response is a gzip passthrough with no content-length - an intermediary re-coded it, so nothing proves the transfer was whole. Ask again with date_from/date_to; the server then returns a filtered, verifiable response.` }], isError: true };
        }
        if (stored > MCP_MAX_PASSTHROUGH_BYTES) {
          await discard(r);
          // Above the server's own filter ceiling a date window is not a way out: the
          // filtered request is refused 400 unsupported_filter, so this tool would send the
          // user round a loop. Name the client that can actually read it (R620).
          const beyondFilter = stored > FILTER_MAX_STORED_BYTES;
          return { content: [{ type: "text", text: `${series_id}: this series is served whole as ${(stored / (1024 * 1024)).toFixed(1)} MB of compressed CSV - more than this tool can hold in memory, and far more than max_rows=${max_rows} would show. ` + (beyondFilter ? `It is also past the server's server-side filtering limit, so a date window will be refused too: this series cannot be read through this tool at all. Download the whole CSV directly instead (the server streams it): curl --compressed -H "X-API-Key: $ELKASSABGIDATA_KEY" -o series.csv "${ECON}/v1/series/${enc}.csv".` : `Ask again with date_from/date_to for the window you need.`) }], isError: true };
        }
      }
      // EVERY shape is capped, not just the one that declares its size. A windowed request
      // takes the inflate path - chunked, no content-length, no citation-omitted header - so
      // the passthrough guard above never sees it, and a measured window of one test series
      // returned 133,483,150 bytes: past the isolate's 128 MB limit, before the ~1.8x this
      // tool's own line pipeline adds on top (R620). The read stops at the cap instead.
      const { text: csv, capped } = await readCapped(r, MCP_MAX_TEXT_BYTES);
      if (capped) {
        return { content: [{ type: "text", text: `${series_id}: the response passed ${(MCP_MAX_TEXT_BYTES / (1024 * 1024)).toFixed(0)} MB of CSV and was stopped - reading it whole would exceed this tool's memory limit and end the session. Ask again for a narrower date_from/date_to window, or download the whole CSV directly: curl --compressed -H "X-API-Key: $ELKASSABGIDATA_KEY" -o series.csv "${ECON}/v1/series/${enc}.csv".` }], isError: true };
      }
      // Comment lines start with '#': the citation preamble (never on raw=1) and, on a response
      // with no content-length that is not a gzip passthrough, the mandatory completeness line
      // `# econdl-complete rows=N` (CONTRACT.md 2026-09-02): a server-side abort reaches us as a
      // clean end of body, so the line is the only proof the transfer was whole (R607).
      const allLines = csv.split("\n").map((l) => l.replace(/\r$/, ""));
      const nonblank = allLines.filter((l) => l.trim() !== "");
      const last = nonblank.length ? nonblank[nonblank.length - 1] : "";
      const mk = /^#\s*econdl-complete\s+rows=(\d+)\s*$/.exec(last);
      if (!hasLen && !passthrough && !mk) {
        return { content: [{ type: "text", text: `${series_id}: the response declared no content-length and does not end with the '# econdl-complete rows=N' line the contract requires - the transfer was cut off; retry.` }], isError: true };
      }
      const dataLines = nonblank.filter((l) => !l.startsWith("#"));
      if (mk && dataLines.length - 1 !== Number(mk[1])) {
        return { content: [{ type: "text", text: `${series_id}: the completeness line says ${mk[1]} rows but ${dataLines.length - 1} were received - the transfer was cut off; retry.` }], isError: true };
      }
      if (dataLines.length <= 1) {
        // An empty 200 is forbidden by the contract, and this was the only reference client
        // that rendered one as a successful empty table - a `content-length: 0` passes every
        // size guard there is (R620). The Python client raises EmptyBody here.
        return { content: [{ type: "text", text: `${series_id}: the server returned no data rows at all. The contract forbids an empty 200, so this is a fault, not an empty series: retry, and if it persists the series is not being served correctly.` }], isError: true };
      }
      const header = dataLines[0] ?? "";
      const rows = dataLines.slice(1);
      let body: string;
      let note = "";
      if (rows.length > max_rows) {
        const head = Math.ceil(max_rows * 0.6), tail = max_rows - head;
        body = [...rows.slice(0, head),
          `… [${(rows.length - max_rows).toLocaleString()} rows omitted — use date_from/date_to or raise max_rows] …`,
          ...rows.slice(rows.length - tail)].join("\n");
        note = ` (${rows.length.toLocaleString()} total, ${max_rows} shown)`;
      } else {
        body = rows.join("\n");
      }
      return text(
        `${metaBlock}${series_id} — ${rows.length.toLocaleString()} observations${note}\n\n${header}\n${body}\n\n` +
        `Source: Econ Data Library (econdatalibrary.com). Honor the license above; see the data-honesty resource for standing caveats.`);
    });

    s.registerTool("get_econ_series_metadata", {
      title: "Economic Series Metadata",
      description:
        "Full metadata for one econ series: title, frequency, geography, unit, " +
        "license (incl. commercial-use flag), attribution/citation, coverage " +
        "dates. Free, no key needed.",
      inputSchema: { series_id: z.string() },
      annotations: { readOnlyHint: true },
    }, async ({ series_id }) => {
      const r = await upstream(`${ECON}/v1/series/${encodeURIComponent(series_id)}.metadata.json`);
      if (!r.ok) return relayError(r, "get_econ_series_metadata");
      return text(JSON.stringify(await r.json(), null, 1));
    });

    s.registerTool("list_econ_sources", {
      title: "List Economic Data Sources",
      description:
        "List the Econ Data Library's sources (statistical offices, monetary authorities, " +
        "IGOs, research datasets) with their licenses, counted live. Free.",
      inputSchema: {
        contains: z.string().optional().describe("Case-insensitive filter on source id/name, e.g. 'bank' or 'imf'"),
      },
      annotations: { readOnlyHint: true },
    }, async ({ contains }) => {
      const r = await upstream(`${ECON}/v1/sources`);
      if (!r.ok) return relayError(r, "list_econ_sources");
      // /v1/sources returns {total, sources:[...]}, not a bare array — casting
      // the body to an array made .filter throw on every call (verified live).
      const payload = await jsonCapped<{ sources?: Array<Record<string, any>> }>(r);
      if (!payload) return { content: [{ type: "text", text: "The source list came back larger than this tool can hold, or unparseable. Retry; if it persists the endpoint is at fault." }], isError: true };
      let list = payload.sources ?? [];
      if (contains) {
        const c = contains.toLowerCase();
        list = list.filter((x) =>
          String(x.source).toLowerCase().includes(c) || String(x.name ?? "").toLowerCase().includes(c));
      }
      const shown = list.slice(0, 120);
      return text(
        `${list.length} source(s)${contains ? ` matching "${contains}"` : ""}${shown.length < list.length ? ` (showing ${shown.length})` : ""}:\n\n` +
        shown.map((x) =>
          `${x.source} — ${x.name ?? ""} · ${x.license?.name ?? x.license?.id ?? "license: see source page"}${x.license?.commercial_ok === false ? " [non-commercial]" : ""}`).join("\n"));
    });

    s.registerTool("get_data_freshness", {
      title: "Data Freshness",
      description:
        "Live per-source update status straight from the automated updater's " +
        "ledger: last successful update, data frontier, and honest stale/" +
        "failure flags (dates are NEVER fabricated — a silent upstream outage " +
        "shows here as stale, not papered over). Free.",
      inputSchema: {
        source: z.string().optional().describe("One source id; omit for the full board"),
      },
      annotations: { readOnlyHint: true },
    }, async ({ source }) => {
      const r = await upstream(`${ECON}/v1/last-updates`);
      if (!r.ok) return relayError(r, "get_data_freshness");
      const d = await jsonCapped<{ generated?: string; datasets: Array<Record<string, any>> }>(r);
      if (!d) return { content: [{ type: "text", text: "The update ledger came back larger than this tool can hold, or unparseable. Retry; if it persists the endpoint is at fault." }], isError: true };
      let rows = d.datasets ?? [];
      if (source) rows = rows.filter((x) => x.source === source);
      if (!rows.length) return text(`No update-ledger rows${source ? ` for '${source}'` : ""}. Sources join the automated rollout in phases; absent = still on its verified initial load.`);
      const counts: Record<string, number> = {};
      for (const x of rows) counts[x.status] = (counts[x.status] ?? 0) + 1;
      return text(
        `Update ledger (generated ${d.generated ?? "?"}): ` +
        Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ") + "\n\n" +
        rows.slice(0, 100).map((x) =>
          `${x.source}/${x.unit ?? "_all"} · ${x.status} · data through ${x.last_obs_date ?? "—"} · checked ${String(x.source_date_accessed ?? x.last_updated ?? "—").slice(0, 16)}`).join("\n"));
    });

    s.registerTool("get_econ_bundle_manifest", {
      title: "Economic Data Bundle Manifest",
      description:
        "A citable bundle manifest (Frictionless data package) for several econ series - up to 50 " +
        "explicit ids, or every series of one small source (up to " + `${BUNDLE_SOURCE_MAX.toLocaleString()}` +
        " series): the per-series download URLs grouped by source, each source's attribution and " +
        "licence, and any id that could not be resolved (reported, never dropped). The URLs serve " +
        "the CURRENT data - this is not a frozen vintage. Free, no key needed for the manifest; " +
        "downloading the URLs needs the key.",
      inputSchema: {
        ids: z.array(z.string().min(3)).min(1).max(50).optional()
          .describe("Up to 50 exact catalog ids from search_econ_series"),
        source: z.string().optional()
          .describe(`One source id - every series of that source, if it has at most ${BUNDLE_SOURCE_MAX.toLocaleString()}`),
      },
      annotations: { readOnlyHint: true },
    }, async ({ ids, source }) => {
      const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
      if ((ids?.length ? 1 : 0) + (source ? 1 : 0) !== 1) {
        return fail("Give exactly one of ids (a list of series ids) or source (one source id).");
      }
      // The endpoint splits every ids= value on commas, so an id that CONTAINS a comma would come
      // back as invented not_found fragments (AR-186 #4: 150,362 catalogue ids contain one).
      const commaIds = (ids ?? []).filter((x) => x.includes(","));
      if (commaIds.length) {
        return fail(`These ids contain a comma, which the manifest endpoint cannot carry (it would split them ` +
          `into ids that do not exist): [${commaIds.slice(0, 5).join("] [")}]. Leave them out of the manifest and ` +
          `get each one with get_econ_series / get_econ_series_metadata instead.`);
      }
      if (source) {
        // SIZE IT FIRST. The manifest does one catalogue read per series, so a large source takes
        // longer than this tool waits (AR-186 #2: 3,822 series took 59.8 s; 170 of 321 sources are
        // past what fits). The catalogue's total for a source is cheap and edge-cached.
        const c = new URL(`${ECON}/v1/catalog`);
        c.searchParams.set("source", source);
        c.searchParams.set("limit", "1");
        const cr = await upstream(c.toString());
        if (!cr.ok) return relayError(cr, "get_econ_bundle_manifest (sizing the source)");
        const cd = await jsonCapped<{ total?: number }>(cr);
        const total = Number(cd?.total);
        if (!cd || !Number.isFinite(total)) return fail(`Could not read how many series '${source}' has; nothing was requested.`);
        if (total === 0) return fail(`The catalogue lists no series for source '${source}' - check the id with list_econ_sources.`);
        if (total > BUNDLE_SOURCE_MAX) {
          return fail(`Source '${source}' has ${total.toLocaleString()} catalogued series - more than one manifest ` +
            `can be built for within this tool's time limit (${BUNDLE_SOURCE_MAX.toLocaleString()}). Narrow it: ` +
            `search_econ_series(query, source="${source}") and pass up to 50 ids, or fetch series one by one ` +
            `with get_econ_series.`);
        }
      }
      const u = new URL(`${ECON}/v1/bundle`);
      if (ids?.length) u.searchParams.set("ids", ids.join(","));
      if (source) u.searchParams.set("source", source);
      let r: Response;
      try {
        r = await upstream(u.toString(), null, false);
      } catch (e) {
        // the sizing total comes from a cached count that has drifted before (R709), so a
        // manifest under the limit can still take longer than the wait (AR-186 L1)
        return fail(`The manifest did not arrive within ${UPSTREAM_TIMEOUT_MS / 1000} s ` +
          `(${e instanceof Error ? e.message : String(e)}) - the server builds it one series at a time. ` +
          `Ask for fewer series: pass up to 50 ids from search_econ_series.`);
      }
      if (!r.ok) return relayError(r, "get_econ_bundle_manifest");
      // read through the same ceiling as every fleet-sized JSON body (R622)
      const d = await jsonCapped<{
        "econdl:resource_url_count"?: number;
        resources?: Array<{
          name: string; path: string[];
          "econdl:provenance"?: { name?: string | null; attribution?: string | null; terms_url?: string | null;
            license?: { id?: string | null; name?: string | null; commercial_ok?: boolean | null;
              no_modify?: boolean | null } | null };
        }>;
        "econdl:unresolved"?: Array<{ id: string; reason: string }>;
      }>(r);
      if (!d) return fail("The manifest came back larger than this tool can hold, or did not parse. Ask for fewer series.");
      const res = d.resources ?? [];
      const unresolved = d["econdl:unresolved"] ?? [];
      const SHOW = 40;
      let shown = 0;
      const blocks = res.map((x) => {
        const take = Math.max(0, Math.min(x.path.length, SHOW - shown));
        shown += take;
        const p = x["econdl:provenance"] ?? {};
        const lic = p.license ?? {};
        const head = `${x.name}${p.name ? ` (${p.name})` : ""}: ${x.path.length.toLocaleString()} series\n` +
          `   licence: ${lic.name ?? lic.id ?? "see the source's metadata"}${lic.commercial_ok === false ? " - NON-COMMERCIAL" : ""}${lic.no_modify ? " - NO MODIFICATION" : ""}` +
          `${p.terms_url ? ` · terms ${p.terms_url}` : ""}\n` +
          (p.attribution ? `   attribution: ${p.attribution}\n` : "");
        const urls = x.path.slice(0, take).map((u2) => `   ${ECON}${u2}`);
        const more = x.path.length - take;
        return head + urls.join("\n") + (more > 0 ? `\n   … ${more.toLocaleString()} more URL(s) for this source` : "");
      });
      const keyNote = this.key()
        ? "A key is configured on this MCP server - the SAME key authorizes these URLs (send it as the X-API-Key header; never paste it into chat)."
        : `No key is configured on this MCP server. ${KEY_FOR_URLS_MSG}`;
      return text(
        `Bundle manifest generated ${new Date().toISOString().slice(0, 10)}: ` +
        `${(d["econdl:resource_url_count"] ?? 0).toLocaleString()} series URL(s) in ${res.length} source(s)` +
        `${unresolved.length ? `; ${unresolved.length} id(s) NOT resolved` : ""}. The URLs serve the current data, ` +
        `not a frozen vintage - record the date you download.\n\n` +
        blocks.join("\n\n") +
        (unresolved.length ? `\n\nNot resolved (reported, never dropped):\n` +
          unresolved.slice(0, 50).map((x) => `- ${x.id}: ${x.reason}`).join("\n") : "") +
        `\n\n${keyNote}\nFetch each URL with the key, e.g. curl --compressed -H "X-API-Key: $ELKASSABGIDATA_KEY" -o <file>.csv "<url>".`);
    });

    // ═════════════════ HF DATA LIBRARY ═════════════════
    s.registerTool("get_hf_download_link", {
      title: "HF Equity Data Download Link",
      description:
        "Authenticated download instructions for HF Data Library's 1-minute " +
        "OHLCV bars (per-ticker US stocks/ETFs from IEX Exchange HIST, 2022-03-07 " +
        "onward; parquet or csv) or the 25 pre-computed academic variables. " +
        "Each file holds a ticker's whole history, so it is fetched by YOUR code, " +
        "not returned inline. HF downloads are paused while the dataset is " +
        "restructured (the URL answers 503 data_paused). Works with the same ElkassabgiData key.",
      inputSchema: {
        ticker: z.string().regex(/^[A-Za-z0-9.]{1,10}$/).describe("e.g. AAPL, SPY"),
        dataset: z.enum(["bars", "variables", "quality"]).default("bars"),
        version: z.enum(["clean", "raw"]).default("clean"),
        format: z.enum(["parquet", "csv"]).default("parquet").describe("csv only applies to bars"),
      },
      annotations: { readOnlyHint: true },
    }, async ({ ticker, dataset, version, format }) => {
      const t = ticker.toUpperCase();
      const url =
        dataset === "bars"
          ? `${HF_API}/v1/download/${t}?version=${version}&format=${format}&via=mcp`
          : `${HF_API}/v1/${dataset}/${t}?version=${version}&via=mcp`;
      const keyNote = this.key()
        ? "A key is configured on this MCP server — the SAME key authorizes these URLs."
        : `No key is configured on this MCP server. ${KEY_FOR_URLS_MSG}`;
      return text(
        `${t} · ${dataset} · ${version}${dataset === "bars" ? " · " + format : " · parquet"}\n\n` +
        `NOTE: HF downloads are paused while the dataset is restructured; the URL answers 503 (data_paused) until they return.\n\n` +
        `URL: ${url}\n` +
        `Auth: send your ElkassabgiData key as the X-API-Key header (do NOT paste keys into chat):\n` +
        `  curl -H "X-API-Key: $ELKASSABGIDATA_KEY" -o ${t}_${dataset}.${dataset === "bars" ? format : "parquet"} "${url}"\n` +
        `  # or pandas: pd.read_parquet(io.BytesIO(requests.get(url, headers={"X-API-Key": KEY}).content))\n\n` +
        (dataset === "bars"
          ? `Schema: datetime, Open, High, Low, Close, Volume (1-minute, regular session). One row per minute with an IEX trade.\n`
          : `Schema: trade_date + the 25 academic variables (see the variables dictionary resource/tool). One row per trading day.\n`) +
        `${keyNote}\n\nCaveats that MUST accompany analysis: IEX Exchange only (~2-3% of consolidated volume), from 2022-03-07; 1-minute bars ≠ tick data.`);
    });

    s.registerTool("get_hf_variables_dictionary", {
      title: "HF Variables Dictionary",
      description:
        "The exact definitions/formulas of HF Data Library's 25 pre-computed " +
        "academic variables (realized volatility family, spreads, jumps, " +
        "liquidity, data-quality). Verbatim from the published dictionary. Free.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => text(VARIABLES_25));

    // ═════════════════ IP (patents & innovation) ═════════════════
    s.registerTool("list_ip_bundles", {
      title: "IP Data Library Bundles",
      description:
        "List the IP Data Library's snapshot-pinned patent/innovation bundles " +
        "(patent-level measures on US patents; assignee-year panels) with " +
        "sizes, vintages and download paths. Free, no key needed.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      const r = await upstream(`${IP_API}/v1/bundles`);
      if (!r.ok) return relayError(r, "list_ip_bundles");
      const d = await r.json() as { bundles: Array<Record<string, any>>; citation: string };
      const rows = d.bundles.map(b =>
        `- ${b.vintage}/${b.file} (${(Number(b.bytes) / 1e6).toFixed(0)} MB)` +
        (b.description ? `\n    ${b.description}` : ""));
      return text(
        `IP Data Library bundles (ipdatalibrary.com):\n${rows.join("\n")}\n\n` +
        `Download with get_ip_download_link(file, vintage).\nCitation: ${d.citation}`);
    });

    s.registerTool("get_ip_download_link", {
      title: "IP Patent Data Download Link",
      description:
        "Authenticated download instructions for an IP Data Library bundle — " +
        "patent-level innovation measures (citations, originality/generality, " +
        "grant lag, team size) or the assignee-year panel. Parquet, full-history " +
        "files fetched by YOUR code, not returned inline. Works with the same " +
        "ElkassabgiData key as every family library.",
      inputSchema: {
        file: z.enum(["patent_measures.parquet", "assignee_year.parquet"]),
        vintage: z.string().regex(/^v[\w.-]+$/).optional()
          .describe("Snapshot vintage from list_ip_bundles; omit for the newest"),
      },
      annotations: { readOnlyHint: true },
    }, async ({ file, vintage }) => {
      let v = vintage;
      if (!v) {
        const r = await upstream(`${IP_API}/v1/bundles`);
        if (!r.ok) return relayError(r, "get_ip_download_link");
        const d = await r.json() as { bundles: Array<{ vintage: string; file: string }> };
        v = d.bundles.filter(b => b.file === file).map(b => b.vintage).sort().pop();
        if (!v) return text(`No bundle named ${file} is currently served — run list_ip_bundles.`);
      }
      const url = `${IP_API}/v1/bundles/${v}/${file}`;
      const keyNote = this.key()
        ? "A key is configured on this MCP server — the SAME key authorizes this URL."
        : `No key is configured on this MCP server. ${KEY_FOR_URLS_MSG}`;
      return text(
        `${file} · vintage ${v}\n\n` +
        `URL: ${url}\n` +
        `Auth: send your ElkassabgiData key as the X-API-Key header (do NOT paste keys into chat):\n` +
        `  curl -L -H "X-API-Key: $ELKASSABGIDATA_KEY" -o ${file} "${url}"\n` +
        `  # or pandas: pd.read_parquet(io.BytesIO(requests.get(url, headers={"X-API-Key": KEY}).content))\n\n` +
        `${keyNote}\n\n` +
        `Caveats that MUST accompany analysis: forward-citation counts are right-censored for ` +
        `recent patents (fixed-window counts carry truncation flags); originality/generality use ` +
        `CPC subclasses, so levels are not comparable to the USPC-based 2001 NBER files. ` +
        `Responses carry x-citation and x-snapshot-vintage headers.`);
    });

    // ═════════════════ FAMILY ═════════════════
    s.registerTool("get_family_status", {
      title: "ElkassabgiData Family Status",
      description:
        "Live status of the whole ElkassabgiData family - HF, Econ and IP: each library's " +
        "headline stats and data currency, read live. Free.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      const out: string[] = ["ElkassabgiData family status\n"];
      // hf's published figures still count the withdrawn pre-2022 history; they return after the rebuild.
      out.push(
        "HF Data Library (hfdatalibrary.com): downloads are paused while the dataset is restructured to " +
        "IEX Exchange HIST data from 2022-03-07; its figures will be published again after the rebuild.");
      try {
        const r = await upstream(`${ECON}/v1/stats`);
        if (r.ok) {
          const sst = await r.json() as Record<string, any>;
          out.push(
            `Econ Data Library (econdatalibrary.com): ${Number(sst.individual_series).toLocaleString()} individual series, ` +
            `${Number(sst.observations).toLocaleString()} observations, ${sst.sources_catalogued} sources ` +
            `(measured ${sst.as_of}; method: ${sst.method}).` +
            (sst.recalculating ? ` NOTE: ${sst.recalculating_note ?? "these totals are being recalculated and may change."}` : ""));
        } else out.push("Econ Data Library: stats endpoint unreachable right now.");
      } catch { out.push("Econ Data Library: stats endpoint unreachable right now."); }
      try {
        const r = await upstream(`${IP_API}/v1/stats`);
        if (r.ok) {
          const ip = await r.json() as Record<string, any>;
          out.push(
            `IP Data Library (ipdatalibrary.com): ${ip.bundles} patent/innovation bundles ` +
            `(${(Number(ip.total_bytes) / 1e6).toFixed(0)} MB) across vintages ${ip.vintages.join(", ")}; ` +
            `source: ${ip.source}.`);
        } else out.push("IP Data Library: stats endpoint unreachable right now.");
      } catch { out.push("IP Data Library: stats endpoint unreachable right now."); }
      out.push(`\nOne free account covers every library: ${ACCOUNT_URL}`);
      return text(out.join("\n"));
    });

    s.registerTool("get_auth_status", {
      title: "Authentication Status",
      description:
        "Whether this MCP connection has an ElkassabgiData API key configured " +
        "(masked — the key itself is never echoed), and how to add one.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      const k = this.key();
      return text(k
        ? `A key is configured (${k.slice(0, 4)}…, ${k.length} chars). Data tools are unlocked; the same key works on every ElkassabgiData library. It is used server-side only and never echoed into the conversation.`
        : `No key configured. Browse tools (search, metadata, freshness, status) work without one. ` +
          `Data downloads need ${KEY_HOWTO}`);
    });

    // ═════════════════ RESOURCES ═════════════════
    s.registerResource("data-honesty-charter", "elkassabgidata://honesty", {
      description: "Standing data caveats every analysis should disclose (HF coverage, licensing, freshness semantics).",
      mimeType: "text/plain",
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: HONESTY_CHARTER }],
    }));

    s.registerResource("hf-variables-dictionary", "elkassabgidata://variables", {
      description: "The 25 pre-computed academic variables, verbatim definitions.",
      mimeType: "text/plain",
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: VARIABLES_25 }],
    }));

    s.registerResource("about", "elkassabgidata://about", {
      description: "What the ElkassabgiData family is and how accounts work.",
      mimeType: "text/plain",
    }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text:
        "ElkassabgiData (elkassabgidata.com) is a family of free, research-grade data libraries " +
        "by Ahmed Elkassabgi: HF Data Library (1-minute US equity OHLCV from IEX Exchange HIST, 2022-03-07→present, " +
        "downloads paused while it is restructured; raw+clean, " +
        "25 academic variables), Econ Data Library (billions of economic/financial series from hundreds of " +
        "sources with per-series licensing and citations) and IP Data Library (patent & innovation measures " +
        "from USPTO data). Live figures: get_family_status. ONE free account works across every " +
        `library, current and future: ${ACCOUNT_URL}. Cite series using the attribution shipped in their metadata.` }],
    }));

    // ═════════════════ PROMPTS ═════════════════
    s.registerPrompt("analyze_econ_series", {
      description: "Guided, honesty-first analysis of one economic series.",
      argsSchema: { series_id: z.string() },
    }, ({ series_id }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        `Analyze the economic series ${series_id} from the Econ Data Library. Steps: ` +
        `1) get_econ_series_metadata for title/license/citation; 2) get_econ_series for the data ` +
        `(window with date_from if long); 3) describe level/trend/turning points, compute growth rates ` +
        `where meaningful; 4) check get_data_freshness for its source and state the data frontier; ` +
        `5) end with the required attribution line and any license restriction, plus the caveats from ` +
        `the elkassabgidata://honesty resource that apply. Never interpolate missing values.` } }],
    }));

    s.registerPrompt("compare_countries", {
      description: "Cross-country comparison of one indicator, honestly aligned.",
      argsSchema: {
        indicator: z.string().describe("e.g. 'inflation, consumer prices'"),
        countries: z.string().describe("comma-separated, e.g. 'DEU,FRA,ITA'"),
      },
    }, ({ indicator, countries }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        `Compare "${indicator}" across ${countries} using the Econ Data Library. ` +
        `search_econ_series per country (prefer one source for comparability — worldbank ids follow ` +
        `'worldbank:<INDICATOR>:<ISO3>'); fetch each with get_econ_series; align by date WITHOUT ` +
        `interpolation; present a compact table + the 3 most decision-relevant observations; ` +
        `cite with each series' attribution and note any license restrictions.` } }],
    }));

    s.registerPrompt("hf_event_study", {
      description: "Event-study scaffold on HF 1-minute equity data (code-executing agents).",
      argsSchema: {
        ticker: z.string(),
        event_date: z.string().describe("YYYY-MM-DD"),
      },
    }, ({ ticker, event_date }) => ({
      messages: [{ role: "user", content: { type: "text", text:
        `Run an intraday event study for ${ticker} around ${event_date} using HF Data Library 1-minute bars. ` +
        `1) get_hf_download_link(ticker=${ticker}, dataset=bars, version=clean) and download the parquet in your ` +
        `code environment with the user's key from $ELKASSABGIDATA_KEY (never paste the key into chat); ` +
        `2) window ±5 trading days; compute minute returns, cumulative abnormal return vs the ticker's own ` +
        `intraday mean pattern, and realized volatility before/after; 3) plot; 4) disclose the standing caveats: ` +
        `IEX Exchange only (~2-3% of consolidated volume) from 2022-03-07, ` +
        `1-minute bars are not tick data. Cite: HF Data Library (hfdatalibrary.com), DOI 10.5281/zenodo.19501604.` } }],
    }));
  }
}

// ── landing page ─────────────────────────────────────────────────────────────
const LANDING = `<!doctype html><html><head><meta charset="utf-8"><title>ElkassabgiData MCP</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;max-width:680px;margin:3rem auto;padding:0 1rem;color:#111827;line-height:1.6}
h1{font-family:Georgia,serif}code{background:#f3f4f6;padding:.15rem .4rem;border-radius:5px}
.gold{color:#977f3f}</style></head><body>
<h1>Elkassabgi<span class="gold">Data</span> MCP server</h1>
<p>AI-native access to the family of free research data libraries —
<a href="https://econdatalibrary.com">Econ Data Library</a> (billions of economic series),
<a href="https://hfdatalibrary.com">HF Data Library</a> (1-minute US equity data) and
<a href="https://ipdatalibrary.com">IP Data Library</a> (patent &amp; innovation measures) - one server for all of them.</p>
<p><b>Connect:</b> add this server to Claude, Cursor, or any MCP client:</p>
<p><code>https://elkassabgidata-mcp.elkassabgi.workers.dev/mcp</code></p>
<p><b>Downloads</b> need the free ElkassabgiData key (browse/search is open). Configure it as an
<code>X-API-Key</code> header, <code>Authorization: Bearer</code>, or append
<code>?api_key=YOUR_KEY</code> to the URL above.
<a href="https://econdatalibrary.com/account">Get a free key</a> — one account for every library.</p>
<p>Tools: search &amp; fetch econ series with citations · bundle manifests · per-source freshness board ·
HF bars/variables download links · IP bundle download links · family status · honesty charter · analysis prompts.</p>
</body></html>`;

// ── entry: extract the per-request key into props, serve /mcp ────────────────
const handler = ElkassabgiDataMCP.serve("/mcp", { binding: "MCP_OBJECT" });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(LANDING, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const auth = request.headers.get("authorization") ?? "";
    const apiKey =
      request.headers.get("x-api-key")?.trim() ||
      (auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "") ||
      url.searchParams.get("api_key")?.trim() || null;
    (ctx as ExecutionContext & { props: Props }).props = { apiKey };
    return handler.fetch(request, env, ctx);
  },
};
