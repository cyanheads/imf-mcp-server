<div align="center">
  <h1>@cyanheads/imf-mcp-server</h1>
  <p><b>Query IMF SDMX 3.0 macroeconomic data — hundreds of dataflows across 190 countries, WEO projections, BOP, CPI, exchange rates, and national accounts via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.9-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/imf-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.30.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/imf-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/imf-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.14-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/imf-mcp-server/releases/latest/download/imf-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=imf-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW1mLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22imf-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fimf-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://imf.caseyjhand.com/mcp](https://imf.caseyjhand.com/mcp)

</div>

---

## Tools

Five tools covering the full IMF SDMX 3.0 query workflow, plus a DuckDB-backed canvas layer for SQL analytics over large multi-country result sets:

| Tool | Description |
|:-----|:------------|
| `imf_list_databases` | List IMF SDMX dataflows available on the portal, a page at a time, with optional name/ID substring filtering |
| `imf_get_database` | Fetch a dataflow's dimension list and a codelist preview per dimension — resolves human terms to SDMX codes before querying |
| `imf_query_dataset` | Query a dataflow by dimension key over a time range; large result sets spill to DataCanvas |
| `imf_dataframe_describe` | List DataCanvas tables and columns staged by a prior `imf_query_dataset` call |
| `imf_dataframe_query` | Run a read-only SQL SELECT across staged DataCanvas tables for multi-country comparisons and aggregations |

### `imf_list_databases`

Entry point for every IMF query workflow — browse and filter the dataflow catalog, a page at a time.

- Hundreds of dataflows covering WEO projections, balance of payments, CPI, exchange rates, money/finance statistics, and national accounts
- Vintage (historical snapshot) dataflows excluded by default; set `include_vintages=true` to include them
- Case-insensitive substring filter across ID, name, and description — matched against the full description, not the shortened one returned
- Paged: `limit` (default 50, max 200) and `offset`. `total_count` is the number of matches, `returned_count` the size of the page, and a notice names the next `offset` while matches remain
- Descriptions are cut to 200 characters here; `imf_get_database` and the `imf://database/{dataflow_id}` resource return the full text for the dataflow you settle on

---

### `imf_get_database`

Resolve human-readable terms to SDMX dimension codes before querying.

- Returns every dimension ID, its position, its label from the DSD concept scheme (`WGT_TYPE` → `Weight Type`), and a codelist preview (e.g. `"United States"` → `USA`, `"real GDP growth"` → `NGDP_RPCH`)
- Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE)
- `key_format` field shows the exact dot-separated dimension order required by `imf_query_dataset`
- Codelists truncated at 50 entries inline; use `codelist_filter` to search large codelists by substring (returns all matches, uncapped), or the `imf://database/{dataflow_id}` resource for the full list
- A filter that matches nothing is reported distinctly from a codelist that could not be resolved — the two need opposite next steps

---

### `imf_query_dataset`

Query an IMF SDMX dataflow by dimension key over a time range.

- Dot-separated key in DSD keyPosition order (e.g. `USA.NGDP_RPCH.A` for WEO annual real GDP growth)
- `+` combines codes at one position (e.g. `USA+GBR+DEU.NGDP_RPCH.A`); `*` matches every code at a position (`*.NGDP_RPCH.A` for all countries, `CAN.*.A` for every indicator). Every position needs a code or a `*` — a blank segment matches nothing upstream and is rejected
- `start_period` / `end_period` accept `YYYY`, `YYYY-SN`, `YYYY-QN`, `YYYY-MM`, or `YYYY-MM-DD` whatever the series frequency, and cover the whole period they name — `end_period: 2023` includes `2023-M12` and `2023-Q4`
- Returns observations with `time_period`, `value`, `status`, and series attributes (`unit`, `scale`, `decimals`). Period labels come back as upstream emits them — `2023`, `2023-S1`, `2023-Q1`, `2023-M01`, `2023-01-05` — and any of them can be passed straight back in as a bound
- A key resolving to several series carries `series_metadata`, one `unit`/`scale`/`decimals` entry per `series_key`, because attributes differ between them: in `USA.NGDPD+NGDP_RPCH.*`, `NGDPD` is `USD` at scale `9` while `NGDP_RPCH` is `PT` and unscaled. Canvas rows carry their own series' attributes too. A single-series query keeps the flat `series_attributes` and no list
- `unit` is the upstream code — `PT`, `USD`, `XDC`, `IX`, `NUM`. A key that uses `+` without a `*` anywhere loses it: the portal drops the attribute block for that shape, so `USA.NGDP_RPCH+NGDPD.A` reports `unit: null` on both series where `USA.NGDP_RPCH+NGDPD.*` reports both
- Scale `0` is the upstream sentinel for "no multiplier" — formatted output names it rather than printing a bare `0`, and `structuredContent` keeps the raw code
- Large multi-country or long time-range queries automatically spill to DataCanvas — `canvas_id` and `table_name` are returned for SQL follow-up
- `no_data` errors include availability context from the upstream constraint endpoint: a dataflow that publishes no series at all is reported as such and points at a different dataflow, since no key would work; otherwise `series_count=0` means the code has no coverage and `dataflow_availability` names codes that do, while `series_count>0` means the combination is wrong and `available_codes` lists what does have data per dimension, stating how many of how many it is showing when a dimension is too long to list in full
- A valid key whose data lies entirely outside the requested range fails as `no_data_in_range`, reporting the range the series actually spans — the fix is the range, not the key

---

### `imf_dataframe_describe` / `imf_dataframe_query`

In-conversation SQL analytics over the observation tables that `imf_query_dataset` stages on a DuckDB-backed canvas.

When `imf_query_dataset` returns `truncated: true`, the full dataset is registered as a named table on the canvas. The workflow:

1. Call `imf_query_dataset` — if `truncated: true`, note the `canvas_id` and `table_name`
2. Call `imf_dataframe_describe` with the `canvas_id` to discover table schema
3. Call `imf_dataframe_query` with a SELECT statement for aggregations, cross-country comparisons, or time-series analysis

One SELECT statement per call; a leading `WITH … SELECT` common table expression is accepted. DML and DDL are rejected. A query result is capped at the canvas row limit (default 10,000) — a capped response reports `truncated: true`, and the remainder is reachable with a stable `ORDER BY` plus `LIMIT`/`OFFSET`. Requires `CANVAS_PROVIDER_TYPE=duckdb`.

## Resource

| Type | URI | Description |
|:-----|:----|:------------|
| Resource | `imf://database/{dataflow_id}` | Full metadata for a single IMF SDMX dataflow — all dimensions with complete codelists, `key_format`, name, and description. Stable URI-addressable reference for known dataflow IDs (WEO, BOP, CPI, etc.). |

All resource data is also reachable via `imf_get_database`. The resource URI provides the untruncated codelist for large dimensions that `imf_get_database` caps at 50 entries. The `codelist_filter` parameter on `imf_get_database` is a lighter alternative for targeted code lookup — it returns all substring matches without the cap.

## Data source

Data is sourced from the [International Monetary Fund SDMX 3.0 portal](https://data.imf.org/) under the [IMF Copyright and Terms of Use](https://www.imf.org/en/about/copyright-and-terms). The IMF's terms permit redistribution of statistical data with attribution. Each data-returning tool response includes a `source` field with the required attribution: `Source: International Monetary Fund, <dataflow name>, https://data.imf.org/`.

## Features

Built on [`@cyanheads/mcp-ts-core`](https://www.npmjs.com/package/@cyanheads/mcp-ts-core):

- Declarative tool, resource, and prompt definitions — single file per primitive, framework handles registration and validation
- Unified error handling — handlers throw, framework catches, classifies, and formats
- Pluggable auth: `none`, `jwt`, `oauth`
- Swappable storage backends: `in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`
- Structured logging with optional OpenTelemetry tracing
- STDIO and Streamable HTTP transports

IMF SDMX-specific:

- Keyless access — no API key required; the IMF SDMX 3.0 portal is fully public
- Type-safe SDMX 3.0 compact JSON client with dimension/codelist parsing and DSD validation
- Key dimension count validated against the DSD before each query to catch format mismatches early
- Dataflow catalog cached in-session to minimize round trips on multi-step workflows
- DuckDB-backed DataCanvas spill for large multi-country or long time-range observations

Agent-friendly output:

- Codelist entries carry both the machine code and human-readable label — agents can present meaningful names without a follow-up lookup
- `key_format` field in every dataflow response explicitly states the dimension order, removing guesswork for key construction
- Observations include `status` flags (e.g. `E` for estimate) so agents can communicate data quality caveats
- Canvas spill is transparent — `truncated`, `canvas_id`, and `table_name` are always present in the output schema, letting callers branch on data rather than heuristics

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

To enable SQL analytics over large result sets, add `CANVAS_PROVIDER_TYPE=duckdb` to the `env` block.

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.3.0](https://bun.sh/) or higher (or Node.js v24+).
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
| `CANVAS_PROVIDER_TYPE` | Set to `duckdb` to enable DataCanvas spill for large result sets. | — |
| `IMF_BASE_URL` | IMF SDMX 3.0 base URL. Override for testing or proxied environments. | `https://api.imf.org/external/sdmx/3.0` |
| `IMF_REQUEST_TIMEOUT_MS` | Per-request timeout in milliseconds. | `30000` |
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | Port for HTTP server. | `3010` |
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

| Path | Purpose |
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

## Contributing

Issues and pull requests are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

Apache-2.0 — see [LICENSE](LICENSE) for details.
