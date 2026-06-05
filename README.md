<div align="center">
  <h1>@cyanheads/imf-mcp-server</h1>
  <p><b>Query IMF SDMX 3.0 macroeconomic data — 193 dataflows, 190 countries, WEO projections, BOP, CPI, exchange rates, and national accounts via MCP. STDIO or Streamable HTTP.</b>
  <div>5 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/imf-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^1.29.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/imf-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/imf-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^6.0.3-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.3.11-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/imf-mcp-server/releases/latest/download/imf-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=imf-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvaW1mLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22imf-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fimf-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Tools

Five tools covering the full IMF SDMX 3.0 query workflow, plus a DuckDB-backed canvas layer for SQL analytics over large multi-country result sets:

| Tool | Description |
|:-----|:------------|
| `imf_list_databases` | List all IMF SDMX dataflows available on the portal (193 total), with optional name/ID substring filtering |
| `imf_get_database` | Fetch a dataflow's dimension list and complete codelist — resolves human terms to SDMX codes before querying |
| `imf_query_dataset` | Query a dataflow by dimension key over a time range; large result sets spill to DataCanvas |
| `imf_dataframe_describe` | List DataCanvas tables and columns staged by a prior `imf_query_dataset` call |
| `imf_dataframe_query` | Run a read-only SQL SELECT across staged DataCanvas tables for multi-country comparisons and aggregations |

### `imf_list_databases`

Entry point for every IMF query workflow — browse and filter the full dataflow catalog.

- 193 dataflows covering WEO projections, balance of payments, CPI, exchange rates, money/finance statistics, and national accounts
- Vintage (historical snapshot) dataflows excluded by default; set `include_vintages=true` to include them
- Case-insensitive substring filter across ID, name, and description

---

### `imf_get_database`

Resolve human-readable terms to SDMX dimension codes before querying.

- Returns all dimension IDs, positions, and their complete codelists (e.g. `"United States"` → `USA`, `"real GDP growth"` → `NGDP_RPCH`)
- Country codes are ISO 3-letter (USA, GBR, DEU — not US, GB, DE)
- `key_format` field shows the exact dot-separated dimension order required by `imf_query_dataset`
- Codelists truncated at 50 entries inline; full list available via the `imf://database/{dataflow_id}` resource

---

### `imf_query_dataset`

Query an IMF SDMX dataflow by dimension key over a time range.

- Dot-separated key in DSD keyPosition order (e.g. `USA.NGDP_RPCH.A` for WEO annual real GDP growth)
- `+` syntax for multi-code positions (e.g. `USA+GBR+DEU.NGDP_RPCH.A`)
- Returns observations with `time_period`, `value`, `status`, and series attributes (`unit`, `scale`, `decimals`)
- Large multi-country or long time-range queries automatically spill to DataCanvas — `canvas_id` and `table_name` are returned for SQL follow-up

---

### `imf_dataframe_describe` / `imf_dataframe_query`

In-conversation SQL analytics over the observation tables that `imf_query_dataset` stages on a DuckDB-backed canvas.

When `imf_query_dataset` returns `truncated: true`, the full dataset is registered as a named table on the canvas. The workflow:

1. Call `imf_query_dataset` — if `truncated: true`, note the `canvas_id` and `table_name`
2. Call `imf_dataframe_describe` with the `canvas_id` to discover table schema
3. Call `imf_dataframe_query` with a SELECT statement for aggregations, cross-country comparisons, or time-series analysis

Only SELECT statements are accepted — DML and DDL are rejected. Requires `CANVAS_PROVIDER_TYPE=duckdb`.

## Resource

| Type | URI | Description |
|:-----|:----|:------------|
| Resource | `imf://database/{dataflow_id}` | Full metadata for a single IMF SDMX dataflow — all dimensions with complete codelists, `key_format`, name, and description. Stable URI-addressable reference for known dataflow IDs (WEO, BOP, CPI, etc.). |

All resource data is also reachable via `imf_get_database`. The resource URI provides the untruncated codelist for large dimensions that `imf_get_database` caps at 50 entries.

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
