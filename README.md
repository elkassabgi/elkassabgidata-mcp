# ElkassabgiData MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives an AI assistant
direct access to the three Elkassabgi data libraries: **economic statistics**,
**high-frequency US equity bars**, and **patent/innovation measures**.

It runs as a Cloudflare Worker with a Durable Object per session.

**Endpoint:** `https://elkassabgidata-mcp.elkassabgi.workers.dev/mcp`

## What it does

Twelve tools across the three libraries, one server for all of them. Browsing, searching and
the download links work with no account; the data itself needs a free API key (see below).

| Tool | Library | Key needed |
|---|---|---|
| `search_econ_series` | Econ | no (paging with `offset`; `lang` for official translated titles) |
| `get_econ_series_metadata` | Econ | no |
| `list_econ_sources` | Econ | no |
| `get_data_freshness` | Econ | no |
| `get_econ_bundle_manifest` | Econ | no for the manifest; yes to download its URLs |
| `get_econ_series` | Econ | yes |
| `get_hf_variables_dictionary` | HF equities | no |
| `get_hf_download_link` | HF equities | no for the link; yes to download the file |
| `list_ip_bundles` | IP / patents | no |
| `get_ip_download_link` | IP / patents | no for the link; yes to download the file |
| `get_family_status` | all | no |
| `get_auth_status` | all | no |

Every response carries the source's own licence with it, because the licence differs per
source and honouring it is the user's obligation as much as ours.

## Getting an API key

Free, instant, and one key works across all three libraries:
<https://hfdatalibrary.com/pages/download>

The key is used server-side only and is never echoed back into the conversation in full:
`get_auth_status` shows only its first four characters and its length, so you can tell which key is set.

## Install

### Claude Code

```
claude mcp add --transport http elkassabgidata \
  https://elkassabgidata-mcp.elkassabgi.workers.dev/mcp \
  --header "Authorization: Bearer YOUR_KEY"
```

### Claude Desktop

```json
{
  "mcpServers": {
    "elkassabgidata": {
      "url": "https://elkassabgidata-mcp.elkassabgi.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "elkassabgidata": {
      "serverUrl": "https://elkassabgidata-mcp.elkassabgi.workers.dev/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY" }
    }
  }
}
```

### ChatGPT developer mode

Add the connector URL directly:

```
https://elkassabgidata-mcp.elkassabgi.workers.dev/mcp?api_key=YOUR_KEY
```

## A worked example

Calling `search_econ_series` with no API key:

```json
{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "search_econ_series",
    "arguments": { "query": "unemployment rate", "limit": 3 }
  }
}
```

The actual response (live server, 2026-10-02; counts change as the catalogue grows):

```
8,294 series match "unemployment rate". Showing 3:

abs:LF:M13.3.1599.20.AUS.M
   Unemployment rate (persons, SA, Australia) [M, AU, Percent] 1978-02-28→2026-04-30 · license:cc-by-4.0
adb:ADB:PPL:LUR_PT:AFG
   Unemployment rate [?, ?] 2001-12-31→2020-12-31 · license:cc-by-3.0-igo-adb
adb:ADB:PPL:LUR_PT:ARM
   Unemployment rate [?, ?] 2000-12-31→2023-12-31 · license:cc-by-3.0-igo-adb

Fetch data with get_econ_series(series_id). Metadata + citation with get_econ_series_metadata.
```

Pass `series_id` to `get_econ_series` to pull the observations.

## Development

```
npm install
npx wrangler dev      # local
npx wrangler deploy   # publish
```

## The libraries

- **Econ Data Library** — <https://econdatalibrary.com>
- **HF Data Library** — <https://hfdatalibrary.com>
- **IP Data Library** — <https://ipdatalibrary.com>

## Licence

MIT — see [`LICENSE`](LICENSE).

The **data** reached through this server is not MIT. Each dataset stays under the terms of
the agency that published it, and those terms travel with every response.
