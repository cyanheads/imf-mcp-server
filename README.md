<div align="center">
  <h1>@cyanheads/imf-mcp-server</h1>
  <p><b>Query IMF SDMX 3.0 macroeconomic data — 100+ dataflows across 190 countries, WEO projections, BOP, CPI, exchange rates, and national accounts via MCP. STDIO or Streamable HTTP.</b>
  <div>6 Tools • 1 Resource • 1 Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.5.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/imf-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/imf-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/imf-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4%2B-blueviolet.svg?style=flat-square)](https://bun.sh/)

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

IMF macroeconomic data across 190 countries: World Economic Outlook projections, balance of payments, CPI, exchange rates, national accounts, and 100+ dataflows in all. Browse the catalog, resolve dimension codes, query time series, and run SQL over large multi-country results. No API key required.

### Tools

| Tool | Description |
|:-----|:------------|
| `imf_list_databases` | List IMF SDMX dataflows, with an optional word filter |
| `imf_get_database` | Fetch a dataflow's dimensions and codelists to resolve terms to SDMX codes |
| `imf_query_dataset` | Query a dataflow by dimension key over a time range |
| `imf_dataframe_describe` | List DataCanvas tables and columns staged by `imf_query_dataset` |
| `imf_dataframe_query` | Run a read-only SQL SELECT across staged DataCanvas tables |
| `imf_dataframe_drop` | Remove one staged table or view; disabled by default |

### Resources

| Resource | Description |
|:---|:---|
| `imf://database/{dataflow_id}` | Discovery metadata for one dataflow: dimensions, codelist previews, and `key_format` |

### Skill

| Skill | Description |
|:------|:------------|
| [`imf-guide`](./skills/imf-guide/SKILL.md) | Routing a macro question to the dataflow that holds it, and reading results without mixing projections, group aggregates, or currency units. Served over MCP at `skill://imf-guide/SKILL.md` |

## Capability reference

### `imf_list_databases` <sub>tool</sub>

- `filter` keeps dataflows whose ID, name, or description contains every word (split on spaces and commas, case-insensitive); vintage snapshots such as `WEO_2025_OCT_VINTAGE` are excluded unless `include_vintages=true`
- Paged with `limit` (default 50) and `offset`; a page holds at most 200, and a larger `limit` (up to 1,000) echoes `requested_limit`/`applied_limit`. `total_count` and `returned_count` report the match and page sizes
- Descriptions are cut to 200 characters; `imf_get_database` returns the full text

---

### `imf_get_database` <sub>tool</sub>

- Resolves terms to SDMX dimension codes (countries are ISO 3-letter: `USA`, not `US`) and returns `key_format`, the dot-separated dimension order `imf_query_dataset` requires
- Codelist previews hold 50 entries; set `dimension_id` to page one dimension with `limit`/`offset` (at most 200 per page, `next_offset` names the rest), and `codelist_filter` to keep codes whose ID or name contains every word
- `available_only=true` pages only the codes the dataflow publishes, with series count and time coverage; `agency_id`/`version` are auto-detected when omitted

---

### `imf_query_dataset` <sub>tool</sub>

- Dot-separated key in DSD order, where `+` combines codes at a position and `*` matches all of them; codes and `dataflow_id` are case-insensitive. `start_period`/`end_period` accept `YYYY`, `YYYY-SN`, `YYYY-QN`, `YYYY-MM`, or `YYYY-MM-DD`, and `last_n_observations` (1–1,000,000) keeps each series' last N observations
- Returns `time_period`, `value`, `status`, and series attributes (`unit`, `scale`, `decimals`, `reference_period` where published), with one `series_metadata` entry per series. Responses are held to 100,000 characters: with DataCanvas, larger results spill to it (`output_mode: "canvas"` forces staging, and `staged` reports storage); without it, the earliest observations return with `truncated: true` and `retrieval_guidance`
- Key and range errors are `invalid_key_code` (with the nearest valid codes), `wildcard_in_code_list`, `key_too_long`, `response_too_large`, `no_data`, and `no_data_in_range`; a `+` key that partly returns lists the rest in `missing_series`. Upstream failures are `data_unavailable` and `rate_limited`, both retryable within a 45-second call budget

---

### `imf_dataframe_describe` <sub>tool</sub>

- Lists every staged table with row count and column names and DuckDB types
- Requires `canvas_id` from an `imf_query_dataset` call that returned `staged: true`; call it before `imf_dataframe_query`
- Not listed when `CANVAS_PROVIDER_TYPE=none`, like the other dataframe tools

---

### `imf_dataframe_query` <sub>tool</sub>

- One read-only SQL `SELECT` per call; a leading `WITH … SELECT` is accepted, DML and DDL are rejected
- Results are capped by the canvas row limit (default 10,000), then a 100,000-character response budget; `truncated: true` means either cap trimmed the result. Page with a stable `ORDER BY` plus `LIMIT`/`OFFSET`
- Oversized cells are clipped in the text table while `structuredContent` keeps every value; `response_too_large` means a single row exceeds the budget even so
- Not listed when `CANVAS_PROVIDER_TYPE=none`

---

### `imf_dataframe_drop` <sub>tool</sub>

- Removes one named table or view from a canvas; requires the exact name from `imf_dataframe_describe`
- A repeated or absent drop returns `dropped: false` rather than an error
- Disabled by default; set `IMF_ENABLE_DATAFRAME_DROP=true` (DataCanvas must not be `none`) to register it

---

### `imf://database/{dataflow_id}` <sub>resource</sub>

- Every dimension with up to 50 codelist entries, plus counts, `key_format`, name, and description
- `dataflow_id` comes from `imf_list_databases`; `continuation` metadata points to `imf_get_database` for codelists beyond the preview

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

IMF-specific:

- Keyless access to the public IMF SDMX 3.0 portal
- Typed SDMX 3.0 client that validates the key's dimension count against the DSD before each query
- Dataflow catalog and availability constraints cached in-session
- DuckDB-backed DataCanvas spill for large multi-country or long time-range results

Agent-friendly output:

- Codelist entries carry both the machine code and the human-readable label
- `key_format` in every dataflow response states the dimension order
- Observations carry each dataflow's `status` flags (e.g. `T`, `C`, `NA`) for data-quality caveats
- `staged` and `truncated` are reported separately, and staged results carry `canvas_id`, `table_name`, and retrieval guidance

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

DataCanvas is on by default, so large result sets spill to tables the dataframe tools query with SQL; add `CANVAS_PROVIDER_TYPE=none` to the `env` block to turn it off. Add `IMF_ENABLE_DATAFRAME_DROP=true` only when agents should be able to remove staged tables.

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
| `CANVAS_PROVIDER_TYPE` | DataCanvas spill and the dataframe tools. `none` disables both. | `duckdb` |
| `IMF_ENABLE_DATAFRAME_DROP` | Register `imf_dataframe_drop`. | `false` |
| `IMF_BASE_URL` | IMF SDMX 3.0 base URL. | `https://api.imf.org/external/sdmx/3.0` |
| `IMF_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds (integer, 1–2147483647). | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
| `MCP_SESSION_MODE` | HTTP session handling: `stateful`, `stateless`, or `auto`. | `stateless` |
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
| `src/config/canvas-default.ts` | Defaults `CANVAS_PROVIDER_TYPE` to `duckdb`; the entry point's first import. |
| `src/mcp-server/tools/definitions/` | Tool definitions (`*.tool.ts`). |
| `src/mcp-server/resources/definitions/` | Resource definitions (`*.resource.ts`). |
| `src/services/canvas/` | DataCanvas accessor — wraps the framework canvas instance. |
| `src/services/imf-sdmx/` | IMF SDMX 3.0 API client — dataflow catalog, DSD fetching, data queries. |
| `skills/` | The published `imf-guide` agent skill, served over MCP and shipped to plugin installs and the `.mcpb` bundle. |
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
