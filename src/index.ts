// ---------------------------------------------------------------------------
// ElkassabgiData MCP server — AI-native access to the family of free
// research-grade data libraries:
//   * Econ Data Library  (econdatalibrary.com)  — billions of economic series
//   * HF Data Library    (hfdatalibrary.com)    — 1-minute US equity bars
//
// Design rules (mirroring the sites exactly):
//   * BROWSE IS FREE, DOWNLOADS ARE KEYED: search/metadata/freshness/status
//     tools work without a key; data tools require the free ElkassabgiData
//     API key (ONE account across every library, current and future).
//   * HONESTY IS LAW: upstream error messages (401/404/429/501/502) are
//     relayed verbatim — they are designed to be actionable. Data caveats
//     (survivorship, source breaks, licensing) ship WITH the data, and
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
const HF_SITE = "https://hfdatalibrary.com";
const ACCOUNT_URL = "https://hfdatalibrary.com/pages/download";
const MAX_CHARS = 45_000;          // per-tool-response ceiling (context-friendly)
const UPSTREAM_TIMEOUT_MS = 25_000;

// ── upstream fetch with timeout + one retry on transient failure ────────────
async function upstream(url: string, apiKey?: string | null): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": "elkassabgidata-mcp", "X-Elkassabgi-Client": "mcp" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const r = await fetch(url, { headers, signal: ctl.signal });
      clearTimeout(t);
      if (r.status >= 500 && attempt === 0) continue;   // one retry on 5xx
      return r;
    } catch (e) {
      clearTimeout(t);
      if (attempt === 0) continue;                       // one retry on abort/network
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

const NO_KEY_MSG =
  "This tool downloads data, which requires the free ElkassabgiData API key — " +
  "ONE account for every Elkassabgi data library (hfdatalibrary.com, " +
  "econdatalibrary.com, and future databases). If you registered on either " +
  `site, that key works here. Get one free at ${ACCOUNT_URL} , then add it to ` +
  "this MCP server's configuration (Authorization: Bearer <key>, X-API-Key " +
  "header, or ?api_key=<key> appended to the server URL).";

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

const HONESTY_CHARTER = `ElkassabgiData honesty charter (relay these caveats with any analysis):
• HF universe (1,391 US stocks/ETFs) is a recent snapshot — SURVIVOR-BIASED before ~2022. Cross-sectional results on earlier years must disclose this.
• HF source break: post-2022-03-01 bars come from IEX Exchange HIST (~2-3% of consolidated volume); earlier data from a consolidated-history vendor. Volume levels are not comparable across the break.
• 1-minute bars are NOT tick data: no quotes, no trade-level timestamps, no order book.
• Econ licensing is PER SOURCE: most are CC-BY-class (attribution required); some are academic-use-only (EPU, Fama-French) or non-redistributable (served as metadata/pointers only). The license ships in every series' metadata — honor it.
• Freshness is never fabricated: a series' date advances only when observations were actually fetched; failures surface as stale flags, not silent gaps (see get_data_freshness).
• Missing values stay missing: nothing is interpolated, forward-filled, or invented anywhere in the pipeline.`;

// ── the MCP agent ────────────────────────────────────────────────────────────
export class ElkassabgiDataMCP extends McpAgent<Env, Record<string, never>, Props> {
  server = new McpServer({
    name: "elkassabgidata",
    version: "1.0.0",
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
        "Search the Econ Data Library catalog (billions of series from 300+ sources: " +
        "national accounts, prices, trade, labor, energy, markets…). Free, no " +
        "key needed. Returns series ids usable with get_econ_series.",
      inputSchema: {
        query: z.string().min(2).describe("Free-text search, e.g. 'germany inflation' or 'GDP per capita'"),
        source: z.string().optional().describe("Restrict to one source id, e.g. 'worldbank', 'ecb', 'imf_weo'"),
        limit: z.number().int().min(1).max(50).default(15),
      },
      annotations: { readOnlyHint: true },
    }, async ({ query, source, limit }) => {
      const u = new URL(`${ECON}/v1/catalog`);
      u.searchParams.set("q", query);
      u.searchParams.set("limit", String(limit));
      if (source) u.searchParams.set("source", source);
      const r = await upstream(u.toString());
      if (!r.ok) return relayError(r, "search_econ_series");
      const d = await r.json() as { total: number; results: Array<Record<string, unknown>> };
      const lines = (d.results ?? []).map((x) =>
        `${x.series_id}\n   ${x.title ?? "(untitled)"} [${x.frequency ?? "?"}, ${x.geography ?? "?"}${x.unit ? ", " + x.unit : ""}] ${x.start_date ?? "?"}→${x.end_date ?? "?"} · license:${x.license_id ?? "?"}`);
      return text(
        `${d.total?.toLocaleString?.() ?? "?"} series match "${query}"${source ? ` in ${source}` : ""}. Showing ${lines.length}:\n\n` +
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
      const csv = await r.text();
      const lines = csv.trim().split("\n");
      const header = lines[0];
      const rows = lines.slice(1);
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
        "List the Econ Data Library's sources (309: statistical offices, " +
        "central banks, IGOs, research datasets) with their licenses. Free.",
      inputSchema: {
        contains: z.string().optional().describe("Case-insensitive filter on source id/name, e.g. 'bank' or 'imf'"),
      },
      annotations: { readOnlyHint: true },
    }, async ({ contains }) => {
      const r = await upstream(`${ECON}/v1/sources`);
      if (!r.ok) return relayError(r, "list_econ_sources");
      // /v1/sources returns {total, sources:[...]}, not a bare array — casting
      // the body to an array made .filter throw on every call (verified live).
      const payload = await r.json() as { sources?: Array<Record<string, any>> };
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
      const d = await r.json() as { generated?: string; datasets: Array<Record<string, any>> };
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

    // ═════════════════ HF DATA LIBRARY ═════════════════
    s.registerTool("get_hf_download_link", {
      title: "HF Equity Data Download Link",
      description:
        "Authenticated download instructions for HF Data Library's 1-minute " +
        "OHLCV bars (full per-ticker history, 1,391 US stocks/ETFs, 2002→" +
        "yesterday; parquet or csv) or the 25 pre-computed academic variables. " +
        "Files are full-history (up to millions of rows) so they are fetched " +
        "by YOUR code, not returned inline. Works with the same ElkassabgiData key.",
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
        : `No key is configured on this MCP server. ${NO_KEY_MSG}`;
      return text(
        `${t} · ${dataset} · ${version}${dataset === "bars" ? " · " + format : " · parquet"}\n\n` +
        `URL: ${url}\n` +
        `Auth: send your ElkassabgiData key as the X-API-Key header (do NOT paste keys into chat):\n` +
        `  curl -H "X-API-Key: $ELKASSABGIDATA_KEY" -o ${t}_${dataset}.${dataset === "bars" ? format : "parquet"} "${url}"\n` +
        `  # or pandas: pd.read_parquet(io.BytesIO(requests.get(url, headers={"X-API-Key": KEY}).content))\n\n` +
        (dataset === "bars"
          ? `Schema: datetime, Open, High, Low, Close, Volume (1-minute, regular session). Full history ≈ 0.5–2M rows per ticker.\n`
          : `Schema: trade_date + the 25 academic variables (see the variables dictionary resource/tool). One row per trading day.\n`) +
        `${keyNote}\n\nCaveats that MUST accompany analysis: survivor-biased universe pre-2022; IEX source break 2022-03-01 (volumes not comparable across it); 1-minute bars ≠ tick data.`);
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
        "(patent-level measures on 9.4M+ US patents; assignee-year panels) with " +
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
        : `No key is configured on this MCP server. ${NO_KEY_MSG}`;
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
        "Live status of the whole ElkassabgiData family: both libraries' " +
        "headline stats and data currency. Free.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    }, async () => {
      const out: string[] = ["ElkassabgiData family status\n"];
      try {
        const r = await upstream(`${HF_SITE}/data/metadata.json`);
        if (r.ok) {
          const m = await r.json() as Record<string, any>;
          out.push(
            `HF Data Library (hfdatalibrary.com): ${Number(m.tickers).toLocaleString()} tickers, ` +
            `${Number(m.bars_clean).toLocaleString()} clean 1-min bars, data through ${m.end_date}. ` +
            `Last update: ${m.update_summary ?? m.data_updated}`);
        } else out.push("HF Data Library: status ledger unreachable right now.");
      } catch { out.push("HF Data Library: status ledger unreachable right now."); }
      try {
        const r = await upstream(`${ECON}/v1/stats`);
        if (r.ok) {
          const sst = await r.json() as Record<string, any>;
          out.push(
            `Econ Data Library (econdatalibrary.com): ${Number(sst.individual_series).toLocaleString()} individual series, ` +
            `${Number(sst.observations).toLocaleString()} observations, ${sst.sources_catalogued} sources ` +
            `(measured ${sst.as_of}; method: ${sst.method}).`);
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
        : `No key configured. Browse tools (search, metadata, freshness, status) work without one. ${NO_KEY_MSG}`);
    });

    // ═════════════════ RESOURCES ═════════════════
    s.registerResource("data-honesty-charter", "elkassabgidata://honesty", {
      description: "Standing data caveats every analysis should disclose (survivorship, source breaks, licensing, freshness semantics).",
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
        "by Ahmed Elkassabgi: HF Data Library (1-minute US equity OHLCV, 1,391 tickers, 2002→present, " +
        "raw+clean, 25 academic variables) and Econ Data Library (billions of economic/financial series from " +
        "300+ sources with per-series licensing and citations). ONE free account works across every " +
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
        `survivor-biased universe pre-2022, IEX source break 2022-03-01 (volume levels not comparable across it), ` +
        `1-minute bars are not tick data. Cite: HF Data Library (hfdatalibrary.com), DOI 10.5281/zenodo.19501605.` } }],
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
<a href="https://econdatalibrary.com">Econ Data Library</a> (billions of economic series) and
<a href="https://hfdatalibrary.com">HF Data Library</a> (1-minute US equity data).</p>
<p><b>Connect:</b> add this server to Claude, Cursor, or any MCP client:</p>
<p><code>https://elkassabgidata-mcp.elkassabgi.workers.dev/mcp</code></p>
<p><b>Downloads</b> need the free ElkassabgiData key (browse/search is open). Configure it as an
<code>X-API-Key</code> header, <code>Authorization: Bearer</code>, or append
<code>?api_key=YOUR_KEY</code> to the URL above.
<a href="https://hfdatalibrary.com/pages/download">Get a free key</a> — one account for every library.</p>
<p>Tools: search &amp; fetch econ series with citations · per-source freshness board ·
HF bars/variables download links · honesty charter · analysis prompts.</p>
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
