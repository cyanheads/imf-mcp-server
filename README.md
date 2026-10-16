<div align="center">
  <h1>@cyanheads/imf-mcp-server</h1>
  <p><b>Query IMF SDMX 3.0 macroeconomic data — hundreds of dataflows across 190 countries, WEO projections, BOP, CPI, exchange rates, and national accounts via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.4.3-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/imf-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.3.1-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/imf-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/imf-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.3%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/imf-mcp-server/releases/latest/download/imf-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=imf-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW1mLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22imf-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fimf-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://imf.caseyjhand.com/mcp](https://imf.caseyjhand.com/mcp)

</div>

---

## Overview

IMF macroeconomic data across 190 countries: World Economic Outlook projections, balance of payments, CPI, exchange rates, national accounts, and hundreds more datasets. Browse the catalog, resolve dimension codes, query time series, and run SQL over large multi-country results. No API key required.

### Tools

| Tool | Description |
|:-----|:------------|
| `imf_list_databases` | List IMF SDMX dataflows available on the portal, a page at a time, with an optional filter matching every word across ID, name, and description |
| `imf_get_database` | Fetch a dataflow's dimensions and page either its codelists or the codes with published data — resolves human terms to SDMX codes before querying |
| `imf_query_dataset` | Query a dataflow by dimension key over a time range; large result sets spill to DataCanvas when it is enabled, or return a bounded prefix with retrieval guidance |
| `imf_dataframe_describe` | List DataCanvas tables and columns staged by a prior `imf_query_dataset` call |
| `imf_dataframe_query` | Run a read-only SQL SELECT across staged DataCanvas tables for multi-country comparisons and aggregations |
| `imf_dataframe_drop` | Remove one staged table or view without affecting other tables on the canvas; disabled by default |

### Resources

| Resource | Description |
|:---|:---|
| `imf://database/{dataflow_id}` | Bounded discovery metadata for one IMF SDMX dataflow — dimensions, codelist previews, `key_format`, and continuation guidance |

Continuation beyond the resource's bounded codelist preview runs through `imf_get_database`.

## Capability reference

### `imf_list_databases` <sub>tool</sub>

- `filter` splits on spaces and commas and keeps a dataflow when every word appears, case-insensitively, in its ID, name, or description (`"WEO outlook"` finds WEO and the regional outlooks built on it), matched against the full text — not the shortened preview this tool returns
- Vintage (historical snapshot) dataflows such as `WEO_2025_OCT_VINTAGE` are excluded by default; set `include_vintages=true` to include them
- Paged: `limit` (default 50) and `offset`; a page holds at most 200, so a larger `limit` (up to 1,000) returns 200 and echoes `requested_limit`/`applied_limit`. `total_count` reports total matches, `returned_count` the page size, and a notice names the next `offset` while matches remain
- Descriptions are cut to 200 characters here — `imf_get_database` and the `imf://database/{dataflow_id}` resource return the full text

---

### `imf_get_database` <sub>tool</sub>

- Resolves human-readable terms to SDMX dimension codes (e.g. "United States" → `USA`) and returns each dimension's DSD concept-scheme label
- Country codes are ISO 3-letter (`USA`, `GBR`, `DEU`), not ISO 2-letter (`US`, `GB`, `DE`)
- `key_format` names the exact dot-separated dimension order `imf_query_dataset` requires
- Codelist previews are capped at 50 entries by default; set `dimension_id` to page one dimension with `limit`/`offset`, and `codelist_filter` applies before paging. A page holds at most 200 codes: a larger `limit` (up to 50,000) returns 200, echoes `requested_limit`/`applied_limit`, and `next_offset` names the rest
- `agency_id`/`version` are auto-detected when omitted and matched case-insensitively when given; a mismatch names the agency and version the dataflow exists under
- `codelist_filter` keeps codes whose ID or name contains every word given, in any order — `"GDP constant prices"` finds `NGDP_RPCH` and its constant-price siblings in WEO
- Set `available_only=true` to page codes the dataflow actually publishes, with series count and time coverage, instead of the full codelist
- A `codelist_filter` that matches nothing is reported distinctly from a codelist that could not be resolved — the two need opposite next steps

---

### `imf_query_dataset` <sub>tool</sub>

- Dot-separated key in DSD keyPosition order; `+` combines codes at one position, `*` matches every code there — every position needs a code or `*`, and a blank segment, or one whose `+` members are all blank, is rejected
- Codes are trimmed and matched case-insensitively (`usa.ngdp_rpch.a` queries `USA.NGDP_RPCH.A`), as is `dataflow_id`; empty and repeated `+` members are dropped (`USA++GBR+USA` queries `USA+GBR`), and `notice` names each position that lost one. A code missing from its dimension's codelist fails before the query as `invalid_key_code`, naming the nearest valid codes (`US` → `USA`), and a `*` inside a `+` list fails as `wildcard_in_code_list`
- A `+` list of a few hundred codes runs past the portal's URL limit and fails as `key_too_long`, naming the longest position — use `*` there or split the codes across calls
- A data request that still fails after its retries reports `data_unavailable` (a 5xx, a body that is not JSON, an unreachable or timed-out portal, or the call's 45-second budget spent) or `rate_limited` (HTTP 429, with `retryAfter` when the portal sent one); both are retryable
- `start_period`/`end_period` accept `YYYY`, `YYYY-SN`, `YYYY-QN`, `YYYY-MM`, or a calendar-valid `YYYY-MM-DD`, trimmed; each bound covers its whole period (`end_period: 2023` includes `2023-M12`)
- `last_n_observations` (1–1,000,000) keeps each series' last N observations — `1` returns every series' latest value without downloading its history. "Latest" is per series, and a WEO series ends in projection years (`2031`); with a period bound, the last N inside the range
- Returns `time_period`, `value`, `status`, and series attributes (`unit`, `scale`, `decimals`); a key resolving to multiple series carries one `series_metadata` entry per series, since attributes can differ between them. The formatted text lists every series beside its attributes, one row per shared combination; a result past a thousand series or so lists the first 20 and names the way to the rest
- An index series carries its `reference_period` exactly as published (`2010A`, `2010=100`, `Multiple`), on the series and, where the dataflow publishes one per observation (`CPI`), on each observation; the field is present only when published, and staged tables carry it as `series_reference_period` and `reference_period`
- `unit`/`scale` are upstream codes (`PT`, `USD`, `XDC`, `IX`, `NUM`); a `null` unit means the dataflow publishes none, unless `unresolved_attributes` lists it. The portal leaves a group's unit out of a `+` key on its dimension, and when the extra request that recovers it fails, that field names what stayed null and gives a retry or a `*` key that reports it. `value` is already in base units, and `scale` is the power of ten the IMF publishes the series in — `"9"` renders `published in units of 10^9`, `"0"` renders `published in units`
- A response is held to 100,000 serialized characters. With DataCanvas, larger multi-country or long-range results spill to it (`output_mode: "canvas"` forces staging); `staged` reports storage, `truncated` reports only whether `observations` is an incomplete preview — a staged result can still be untruncated
- Without DataCanvas, a larger result returns its earliest observations with `truncated: true`, full `series_metadata`, and `retrieval_guidance` naming the last `time_period` returned and how to narrow: a narrower key, `start_period`/`end_period`, `last_n_observations`, or `CANVAS_PROVIDER_TYPE=duckdb`. A key whose `series_metadata` alone overflows fails as `response_too_large`
- `no_data` errors carry availability context naming codes that do have coverage; a key with data entirely outside the requested range fails as `no_data_in_range` and reports the range that does
- A `+` key whose requested series partly return nothing keeps what returned and lists the rest in `missing_series` (up to 20, in key order; `missing_series_count` is the total), each with the reason a query for it alone gives: `no_data`, or `no_data_in_range` with the range its data spans

---

### `imf_dataframe_describe` <sub>tool</sub>

- Lists every table staged on a canvas, with row count and column schema (name + DuckDB type)
- Requires `canvas_id` from a prior `imf_query_dataset` call that returned `staged: true`
- Call before `imf_dataframe_query` to confirm table and column names
- Listed only with `CANVAS_PROVIDER_TYPE=duckdb`, like the other dataframe tools; without it the landing page shows it disabled with that hint

---

### `imf_dataframe_query` <sub>tool</sub>

- One read-only SQL `SELECT` per call; a leading `WITH … SELECT` common table expression is accepted, DML and DDL are rejected
- Results are capped first by the canvas row limit (default 10,000), then by a 100,000-character serialized response budget — `row_count` always equals the returned rows, and `truncated: true` means either cap trimmed the result
- Page past a cap with a stable `ORDER BY` plus `LIMIT`/`OFFSET`. A single row too long for the budget comes back alone with its long cells and column names clipped in the text table (`… [clipped: N of M characters]`; read the rest with `SUBSTR`), while `structuredContent` keeps every value and column name whole. A row with too many columns for a table even clipped is listed as one `name: value` line per column in a code block, with nested values flattened to plain text (and a note saying so) when their JSON would not fit. A row that can't be listed either comes back in `structuredContent` with a one-line pointer to it as its text. `response_too_large` means the row's `structuredContent` alone exceeds the budget and asks for fewer columns or aggregation
- The text table escapes `|`, backticks, and line breaks so each row keeps its columns, and shows STRUCT/LIST values as compact JSON; `structuredContent` carries the raw values
- Listed only with `CANVAS_PROVIDER_TYPE=duckdb`

---

### `imf_dataframe_drop` <sub>tool</sub>

- Removes one named table or view from a canvas without affecting the others; requires the exact name from `imf_dataframe_describe`
- Idempotent — a repeated or absent drop returns `dropped: false` rather than an error
- Disabled by default; set `IMF_ENABLE_DATAFRAME_DROP=true` alongside `CANVAS_PROVIDER_TYPE=duckdb` to register it in `tools/list`

---

### `imf://database/{dataflow_id}` <sub>resource</sub>

- Bounded discovery metadata for one dataflow — every dimension with up to 50 codelist entries, counts, `key_format`, name, description
- `dataflow_id` comes from `imf_list_databases`
- Carries `continuation` metadata pointing to `imf_get_database` (with `dimension_id`/`limit`/`offset`) for a codelist beyond the preview

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

IMF-specific:

- Keyless access — no API key required; the IMF SDMX 3.0 portal is fully public
- Type-safe SDMX 3.0 compact JSON client with dimension/codelist parsing and DSD validation
- Key dimension count validated against the DSD before each query to catch format mismatches early
- Dataflow catalog and full availability constraints cached in-session to minimize round trips on multi-step workflows
- DuckDB-backed DataCanvas spill for large multi-country or long time-range observations

Agent-friendly output:

- Codelist entries carry both the machine code and human-readable label — agents can present meaningful names without a follow-up lookup
- `key_format` field in every dataflow response explicitly states the dimension order, removing guesswork for key construction
- Observations include each dataflow's own `status` flags (e.g. `T`, `C`, `NA`) so agents can communicate data quality caveats; a missing value flagged only as not available is dropped as padding
- Canvas placement is explicit — `staged` distinguishes storage from `truncated` preview completeness, and staged results carry `canvas_id`, `table_name`, and retrieval guidance

## Getting started

### Public Hosted Instance

A public instance is available at `https://imf.caseyjhand.com/mcp` — no installation required. Point any MCP client at it via Streamable HTTP:

```json
{
  "mcpServers": {
    "imf-mcp-server": {
      "type": "streamable-http",
      "url": "https://imf.caseyjhand.com/mcp"
    }
  }
}
```

### Self-Hosted / Local

No API key required. Add the following to your MCP client configuration file.

```json
{
  "mcpServers": {
    "imf-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/imf-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "imf-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/imf-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "imf-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run", "-i", "--rm",
        "-e", "MCP_TRANSPORT_TYPE=stdio",
        "ghcr.io/cyanheads/imf-mcp-server:latest"
      ]
    }
  }
}
```

To enable SQL analytics over large result sets, add `CANVAS_PROVIDER_TYPE=duckdb` to the `env` block. Add `IMF_ENABLE_DATAFRAME_DROP=true` only when agents should be able to remove staged tables.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- No API key required.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/imf-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd imf-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment:**

```sh
cp .env.example .env
# edit .env as needed — no required vars for basic use
```

## Configuration

| Variable | Description | Default |
|:---------|:------------|:--------|
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spill for large result sets and register the dataframe tools. Unset, an over-budget query returns its earliest observations with `truncated: true`. | — |
| `IMF_ENABLE_DATAFRAME_DROP` | Advertise and enable destructive table-level DataCanvas cleanup. | `false` |
| `IMF_BASE_URL` | IMF SDMX 3.0 base URL. Override for testing or proxied environments. | `https://api.imf.org/external/sdmx/3.0` |
| `IMF_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds. Every request a tool call makes, retries included, also shares one 45-second budget, so a call settles before a client's default 60-second timeout. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateful`, `stateless`, or `auto` (the schema default, which resolves to stateful). This server declares `stateless` in `src/index.ts`, so a deployment that sets nothing still gets it; setting this to a meaningful value overrides the declaration. | `stateless` |
| `MCP_AUTH_MODE` | Auth mode: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (RFC 5424). | `info` |
| `OTEL_ENABLED` | Enable [OpenTelemetry instrumentation](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of optional overrides.

## Running the server

### Local development

- **Build and run:**

  ```sh
  bun run rebuild

  bun run start:stdio
  # or
  bun run start:http
  ```

- **Run checks and tests:**

  ```sh
  bun run devcheck   # Lint, format, typecheck, security
  bun run test       # Vitest test suite
  bun run lint:mcp   # Validate MCP definitions against spec
  ```

### Docker

```sh
docker build -t imf-mcp-server .
docker run --rm -p 3010:3010 imf-mcp-server
```

The Dockerfile defaults to HTTP transport, stateless session mode, and logs to `/var/log/imf-mcp-server`. OpenTelemetry peer dependencies are installed by default — build with `--build-arg OTEL_ENABLED=false` to omit them.

## Project structure

| Directory | Purpose |
|:-----|:--------|
| `src/index.ts` | `createApp()` entry point — registers tools/resources and inits services. |
| `src/config/server-config.ts` | Server-specific env var parsing and validation with Zod. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/services/canvas/` | DataCanvas accessor — wraps the framework canvas instance. |
| `src/services/imf-sdmx/` | IMF SDMX 3.0 API client — dataflow catalog, DSD fetching, data queries. |
| `tests/` | Unit and integration tests mirroring `src/`. |
| `docs/` | Design notes and directory tree. |

## Development guide

See [`CLAUDE.md`/`AGENTS.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Use `ctx.log` for request-scoped logging, `ctx.state` for tenant-scoped storage
- Register new tools and resources via the barrels in `src/mcp-server/*/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Data source

Data is sourced from the [International Monetary Fund SDMX 3.0 portal](https://data.imf.org/) under the [IMF Copyright and Terms of Use](https://www.imf.org/en/about/copyright-and-terms). The IMF's terms permit redistribution of statistical data with attribution. Each data-returning tool response includes a `source` field with the required attribution: `Source: International Monetary Fund, <dataflow name>, https://data.imf.org/`.

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
