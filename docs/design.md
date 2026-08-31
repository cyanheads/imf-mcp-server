# imf-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `imf_list_databases` | List IMF SDMX dataflows available on the portal, one page at a time. Returns id, agencyID, version, name, and a shortened description. Entry point — every query requires a dataflow id. | `filter` (optional nonblank name/ID/description substring), `include_vintages` (bool, default false), `limit` (1–200, default 50), `offset` (default 0) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `imf_get_database` | Fetch bounded codelist previews for every dimension, or opt into paged codes with published data. Resolves human terms to SDMX codes ("United States" → USA, "Constant prices" → NGDP_RPCH). Mandatory before querying — SDMX keys are opaque without codelist lookups. | `dataflow_id`, `agency_id` (optional, auto-detected), `version` (optional), `available_only` (bool, default false), `codelist_filter` (optional substring), `dimension_id` (optional exact selector), `limit` (1–200), `offset` (requires `dimension_id`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `imf_query_dataset` | Query a dataflow by dimension key (dot-separated codes, e.g. `USA.NGDP_RPCH.A`) over a time range. Returns observations with time, value, and status, plus unit/scale/decimals per series. Large analytical result sets spill to DataCanvas; `output_mode: canvas` explicitly stages any result. | `dataflow_id`, `agency_id`, `version`, `key` (dimension key), `start_period`, `end_period`, `canvas_id` (optional destination), `output_mode` (`auto` or `canvas`) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `imf_dataframe_describe` | List DataCanvas tables and columns staged by a prior `imf_query_dataset` call. Shows table name, row count, and column schema. | `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `imf_dataframe_query` | Run a read-only SQL SELECT against a staged DataCanvas table. Enables multi-country comparisons, time-series aggregation, and cross-indicator joins without hand-rolled loops. | `canvas_id`, `sql` (one SELECT statement; a leading `WITH … SELECT` CTE is accepted) | `readOnlyHint: true`, `openWorldHint: false` |
| `imf_dataframe_drop` | Remove one staged DataCanvas table or view without affecting other tables on the same canvas. Disabled by default and retained in the HTML landing-page inventory. | `canvas_id`, `table_name` from `imf_dataframe_describe` | `readOnlyHint: false`, `idempotentHint: true`, `destructiveHint: true`, `openWorldHint: false` |

### Tool Details

#### `imf_list_databases`

**Input constraints:**
- `filter`: string — case-insensitive substring, matched against id, name, and the **untruncated** description, so a term that survives only in the full text still finds its dataflow.
- `limit`: integer 1–200, default 50. `offset`: integer ≥ 0, default 0. Both are rejected out of range rather than clamped — a silently-capped limit reads as a complete result.

**Output:**
- `dataflows`: array of `{ id, agency_id, version, name, description? }` — this page only
- `total_count`: matches for `filter` + `include_vintages`, before `limit`/`offset`
- `returned_count`: length of `dataflows`; `offset`: matches skipped before this page

**Enrichment:**
- `notice`: emitted when the filter matched nothing (names the filter and the unfiltered total), when `offset` sits past the end of the match set, or when matches remain beyond this page — the last names the exact next `offset`.

**Paging and description shortening.** The catalog is the first call of every workflow, and an unfiltered one used to return all 103 non-vintage dataflows with full descriptions in both channels: 116 KB, of which descriptions were 45.6 KB (median 341 characters, maximum 1,519). That is spent before the caller has chosen anything.

Two independent cuts apply. Descriptions are truncated to 200 characters with a trailing `…`; nothing is lost, because `imf_get_database` and the `imf://database/{dataflow_id}` resource return the full text for the one dataflow the caller picks, and `filter` still searches the untruncated string. Results are then paged at 50 by default.

A page must be recognizable as a page — that is what `total_count` alongside `returned_count`, the notice naming the next `offset`, and the `showing N–M` heading in `format()` are for. A bare count above a shorter list is how a page gets read as the whole catalog.

Rejected: a `verbose` boolean toggling full descriptions. One flag instead of two, but an agent that does not already know the catalog is 103 entries deep has no reason to reach for it, so the expensive shape would stay the default.

**Error contract:**
```
errors: [
  { reason: 'dataflow_list_unavailable', code: ServiceUnavailable, retryable: true,
    when: 'The IMF SDMX structure endpoint that backs the dataflow catalog did not return a usable response',
    recovery: 'Retry in a few moments; the catalog is cached for an hour once it succeeds.' },
]
```

The service applies the error boundary: a failed catalog fetch is logged with its upstream detail and rethrown as a controlled `serviceUnavailable`. Neither the resolved URL (`IMF_BASE_URL` is configurable and can name a private mirror) nor the upstream response body reaches the client. Every tool and the resource reach the catalog, so all four declare this reason.

---

#### `imf_get_database`

**Input constraints:**
- `dataflow_id`: string — value from `imf_list_databases`. No structural regex needed (codes are opaque alphanumeric, validated against the live dataflow list).
- `available_only`: boolean, default false. When true, project the uncapped dataflow-wide availability constraint through the same bounded preview and selected-dimension paging path. Normal codelist mode remains unchanged when false or omitted.
- `codelist_filter`: optional non-blank string — trimmed once, then matched as a case-insensitive substring of code ID or name before paging.
- `dimension_id`: optional exact dimension selector. `limit` (1–200, default 50) and `offset` (integer ≥ 0, default 0) are valid only when this selector is present.

**Output:**
- `dataflow_id`, `agency_id`, `version`, `name`, `description`
- `codelist_filter`: string, present only when a filter was applied — echoing it is what separates "your filter matched nothing" from "this codelist could not be resolved", since both render as an empty array
- `available_only`, `series_count`, `time_period_start`, `time_period_end`: present in availability mode. Every structure dimension remains in the default preview; a constraint-absent dimension has zero available and returned codes.
- `dimension_id`: present when one dimension was selected for paging
- `key_format`: string — dimension names in order, e.g. `"COUNTRY.INDICATOR.FREQUENCY"` (agents must see this to construct keys without re-fetching the DSD)
- `dimensions`: array of `{ id, name, position, codelist, codelist_truncated, available_count?, unfiltered_count, matched_count, returned_count, offset, next_offset? }`. All previews are capped at 50; a selected dimension uses the requested `limit`/`offset`. In availability mode, `available_count` is the pre-filter coverage count, code labels come from the DSD with ID fallback, then `codelist_filter` and paging compose in that order. `codelist_truncated` is true whenever matching entries were omitted before or after the returned page.

**Enrichment:**
- `notice`: emitted when `codelist_filter` matched nothing in any dimension (names the filter and the unfiltered entry counts), when a dimension has no resolvable codelist, or when an offset is past the final match. Reaches both `structuredContent` and the `content[]` trailer.

**Codelist resolution.** Each dimension's codelist is resolved from the `?references=all` payload, authoritative references first:

1. The dimension's `localRepresentation.enumeration` Codelist URN — present on the ESTAT- and IAEG-SDGs-authored structures the portal serves (`NA_MAIN`, `SDG`).
2. The `coreRepresentation.enumeration` URN on the concept named by the dimension's `conceptIdentity` — the reference on IMF-authored structures, which carry no `localRepresentation`. This is what resolves the dimensions no naming convention can name: `QNEA`'s `CL_NEA_*` (codelist token differs from the DSD id), `DIP`/`IMTS`'s `COUNTERPART_COUNTRY` (reuses the primary `CL_*_COUNTRY`), and `LS`'s `CL_LS_TYPE_OF_TRANSFORMAtION` (upstream casing typo, cited verbatim in the URN).
3. The IMF naming convention — `CL_<FLOW>_<DIM>[_PUB]` then `CL_<DIM>[_PUB]`, with the flow token taken from the DSD's own id. Retained for dimensions neither URN resolves.

A URN's version routinely trails the shipped codelist's patch (`CL_CTOT_INDICATOR` cited at `2.0.0`, shipped at `2.0.1`), so lookup widens on each miss: `AGENCY:ID:VERSION` → `AGENCY:ID` → `ID`.

**Error contract:**
```
errors: [
  { reason: 'dataflow_not_found', code: NotFound,
    when: 'dataflow_id does not match any known dataflow',
    recovery: 'Call imf_list_databases to browse available dataflow IDs.' },
  { reason: 'dimension_not_found', code: ValidationError,
    when: 'dimension_id does not match a dimension in the selected dataflow',
    recovery: 'Use an exact dimension ID returned by imf_get_database.' },
  { reason: 'structure_unavailable', code: ServiceUnavailable,
    when: 'api.imf.org returns non-200 on the DSD endpoint',
    recovery: 'Retry after a short wait; the IMF SDMX 3.0 portal is occasionally slow.' },
  { reason: 'dataflow_list_unavailable', code: ServiceUnavailable, retryable: true,
    when: 'The dataflow catalog that dataflow_id is resolved against could not be fetched',
    recovery: 'Retry in a few moments; the catalog is cached for an hour once it succeeds.' },
  { reason: 'availability_unavailable', code: ServiceUnavailable, retryable: true,
    when: 'available_only is true and the dataflow-wide availability constraint cannot be fetched or parsed',
    recovery: 'Retry in a few moments; the IMF availability endpoint did not return usable coverage.' },
]
```

---

#### `imf_query_dataset`

**Input constraints:**
- `key`: string — dot-separated dimension codes in DSD `keyPosition` order, one segment per dimension. Use `+` to combine codes at one position (e.g. `USA+GBR.NGDP_RPCH.A`) and `*` to match every code at a position (e.g. `*.NGDP_RPCH.A`). Every position needs a code or a `*`; a blank segment (`USA..A`) is rejected as `empty_key_segment`, and an omitted position is rejected as `key_dimension_mismatch`. Country codes are ISO 3-letter (USA, not US). Call `imf_get_database` first to obtain the correct `key_format` and valid codes.
- `start_period` / `end_period`: string — `YYYY` (annual), `YYYY-SN` (semi-annual), `YYYY-QN` (quarterly, e.g. `2023-Q1`), `YYYY-MM` (monthly), or a calendar-valid `YYYY-MM-DD` (daily), independent of the dataflow's own frequency. Every label the portal emits is also accepted as a bound, so an observation's `time_period` round-trips. Omit either to use the full available range. Malformed or calendar-invalid values and reversed ranges are rejected before the upstream call.
- `output_mode`: `auto | canvas` — `auto` preserves spill-only behavior. `canvas` stages the full result on a fresh or supplied `canvas_id`; supplying `canvas_id` alone never forces staging.

**Output (inline, no canvas spill):**
- `dataflow_id`, `key`, `start_period`, `end_period`
- `observations`: array of `{ series_key: string, time_period: string, value: number | null, status: string | null }`
- `series_attributes`: `{ unit: string | null, scale: string | null, decimals: number | null }` — the **first** series in the result
- `series_metadata`: array of `{ series_key, unit, scale, decimals }`, present only when the query resolved to more than one series
- `observation_count`: number
- `staged`: boolean (true when the complete result is stored on DataCanvas)
- `truncated`: boolean (true only when inline `observations` is a strict preview of `observation_count`; independent of `staged`)

**Output (canvas spill):**
- `canvas_id`: string — present whenever `staged`; pass to `imf_dataframe_describe` before `imf_dataframe_query`
- `table_name`: string
- `observation_count`: number
- `series_metadata` — as above, describing the whole staged table rather than the inline preview
- `staged: true`; `truncated` is true only when the inline preview omits observations

**Error contract:**
```
errors: [
  { reason: 'dataflow_not_found', code: NotFound,
    when: 'dataflow_id does not match any known dataflow',
    recovery: 'Call imf_list_databases to browse available dataflow IDs.' },
  { reason: 'no_data', code: NotFound,
    when: 'Key is structurally valid but the dataflow holds no series for this code combination, or the dataflow publishes no series at all',
    recovery: 'Read the availability context in the error. An empty dataflow means no key will return data — call imf_list_databases and pick another dataflow. Otherwise, series_count 0 means the code itself has no coverage and dataflow_availability names codes that do, while series_count above 0 means the combination is wrong and available_codes names the codes that have data, stating how many of a dimension it shows when the list is capped.' },
  { reason: 'no_data_in_range', code: NotFound,
    when: 'The key returned observations but start_period/end_period excluded every one of them',
    recovery: 'The key is valid — widen start_period/end_period to overlap the period range reported in the error, or omit both to get the full series.' },
  { reason: 'key_dimension_mismatch', code: ValidationError,
    when: 'Number of dot-separated segments in key does not match the dataflow\'s DSD dimension count',
    recovery: 'Call imf_get_database to get the correct key_format for this dataflow, then reconstruct the key.' },
  { reason: 'empty_key_segment', code: ValidationError,
    when: 'A dot-separated position in key is empty or blank, which matches no series upstream',
    recovery: 'Put * at that position to match every code there, or a code from imf_get_database to pin it.' },
  { reason: 'invalid_period_format', code: ValidationError,
    when: 'start_period or end_period is not one of the recognized period formats',
    recovery: 'Use YYYY (annual), YYYY-SN (semi-annual), YYYY-QN (quarterly, e.g. 2023-Q1), YYYY-MM (monthly), or a calendar-valid YYYY-MM-DD (daily).' },
  { reason: 'invalid_period_range', code: ValidationError,
    when: 'start_period is later than end_period',
    recovery: 'Provide start_period less than or equal to end_period (chronological order).' },
  { reason: 'structure_unavailable', code: ServiceUnavailable,
    when: 'The dataflow structure cannot be fetched after catalog resolution',
    recovery: 'Retry the structure lookup after a short wait.' },
  { reason: 'canvas_unavailable', code: ConfigurationError,
    when: 'output_mode="canvas" was requested while DataCanvas is disabled',
    recovery: 'Enable CANVAS_PROVIDER_TYPE=duckdb or use output_mode="auto".' },
  { reason: 'response_too_large', code: SerializationError,
    when: 'Full series metadata and the staged retrieval handle exceed the response budget before any observation preview',
    recovery: 'Narrow the dimension key to fewer series so full series_metadata and the handle fit.' },
  { reason: 'dataflow_list_unavailable', code: ServiceUnavailable, retryable: true,
    when: 'The dataflow catalog that dataflow_id is resolved against could not be fetched',
    recovery: 'Retry in a few moments; the catalog is cached for an hour once it succeeds.' },
]
```

---

#### `imf_dataframe_describe`, `imf_dataframe_query`, and `imf_dataframe_drop`

**Error contract (all three tools):**
```
errors: [
  { reason: 'canvas_not_found', code: NotFound,
    when: 'canvas_id does not match any registered DataCanvas session (expired, wrong session, or canvas disabled)',
    recovery: 'Re-run imf_query_dataset to obtain a fresh canvas_id.' },
]
```

**Additional error contract on `imf_dataframe_query`:**
```
errors: [
  { reason: 'missing_table', code: NotFound,
    when: 'The canvas exists but sql references a table that is not staged on it',
    recovery: 'Call imf_dataframe_describe to list staged tables, or re-run imf_query_dataset to stage the source data again.' },
  { reason: 'invalid_sql', code: ValidationError,
    when: 'sql is not a single SELECT statement, or is SELECT-shaped but fails to prepare',
    recovery: 'Send exactly one SELECT (or WITH … SELECT) statement and check names against imf_dataframe_describe.' },
  { reason: 'sql_not_permitted', code: ValidationError,
    when: 'sql parses as SELECT but the read-only gate refuses it — external-data/PRAGMA table function, system catalog, or a non-allowlisted plan operator',
    recovery: 'Query only the tables listed by imf_dataframe_describe using plain SELECT features.' },
  { reason: 'response_too_large', code: SerializationError,
    when: 'The first result row cannot fit in the complete structured and formatted response budget',
    recovery: 'Select fewer columns, aggregate the result, or return shorter values so one complete row fits the response budget.' },
]
```

Every reason the DataCanvas gate can raise on `query()` is mapped onto one of these four before it leaves the handler. The framework's own hints name `registerTable()` / `describe()`, which no MCP client can call.

**Additional error contract on `imf_dataframe_drop`:**
```
errors: [
  { reason: 'invalid_table_name', code: ValidationError,
    when: 'table_name is empty, malformed, longer than 63 characters, or a reserved SQL keyword',
    recovery: 'Copy an exact table name from imf_dataframe_describe and try again.' },
]
```

The tool calls the atomic `CanvasInstance.drop(table_name)` primitive directly. A missing table or repeated drop is a successful `dropped: false` result; only the core identifier reasons map to `invalid_table_name`, and unrelated framework errors pass through unchanged. `disabledTool()` keeps the definition in the HTML landing-page inventory with `IMF_ENABLE_DATAFRAME_DROP=true` as its enable hint while omitting it from `tools/list` when the flag is false. The SEP-1649 discovery document at `/.well-known/mcp.json` intentionally carries capabilities and connection metadata without tool definitions.

**Additional constraints on `imf_dataframe_query`:**
- `sql`: one statement, starting with `SELECT` or `WITH`. The handler's `/^\s*(?:SELECT|WITH)\b/i` shape check runs *before* canvas acquisition so `invalid_sql` stays reachable when the canvas is disabled; it deliberately mirrors the framework gate's own `isSelectShaped` test. Statement typing is authoritative in the framework, which parses with DuckDB — `WITH … SELECT` types as `SELECT`, `WITH … INSERT` types as `INSERT` and is rejected.
- Output carries `truncated`. DataCanvas first caps materialization at its row limit (default 10,000); the server then retains the largest prefix whose complete `structuredContent` plus formatted `content[]` fits 100,000 serialized characters. `row_count` always equals returned `rows` and never claims a pre-cap total. `truncated` is true when either cap omitted rows, and `format()` appends deterministic `ORDER BY` plus `LIMIT`/`OFFSET` guidance in both cases. If the first row cannot fit, `response_too_large` directs the caller to project fewer columns, aggregate, or shorten values rather than dropping the row.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `imf://database/{dataflow_id}` | Bounded discovery metadata for one dataflow — dimensions, up to 50 codes each, counts, name, description, and continuation metadata. | None (single record) |

**Resource error behavior:** declares and emits `dataflow_not_found`, `structure_unavailable`, and `dataflow_list_unavailable`, each with sanitized recovery guidance. Shares `imf_get_database`'s bounded projection and returns a continuation object naming `imf_get_database`, `dimension_id`, `limit`, and `offset`; the existing URI remains discovery-only rather than encoding paging controls.

### Prompts

None — this is a pure data server; no reusable message templates warranted.

---

## Overview

Global macroeconomic and financial statistics from the International Monetary Fund, accessed via the IMF's SDMX 3.0 portal (`api.imf.org`). Covers hundreds of dataflows including WEO projections, balance of payments, exchange rates, price indices, international liquidity, government finance, and national accounts for ~190 member countries.

The server follows the **discover → describe → query** workflow: `imf_list_databases` to find a dataflow id, `imf_get_database` to resolve dimension codes, `imf_query_dataset` to fetch observations. Large analytical pulls spill automatically and smaller pulls can be staged explicitly. A staged handle is consumed through `imf_dataframe_describe` before `imf_dataframe_query`, then its table can be reclaimed through opt-in `imf_dataframe_drop`.

**Audience:** Economists, macro/sovereign-risk analysts, development researchers, financial journalists, and agents answering questions like "what's country X's current-account balance?", "how do WEO projections compare across emerging markets?", or "what are US inflation trends since 2010?"

---

## Requirements

- Keyless access — no API key or registration required; all data via public `api.imf.org` endpoints
- SDMX 3.0 JSON format (`application/vnd.sdmx.data+json;version=2.0` or default `application/json`)
- Discovery: `GET /external/sdmx/3.0/structure/dataflow` → all dataflows with id, agencyID, version, name, and the DSD `structure` URN
- Structure: `GET /external/sdmx/3.0/structure/datastructure/{agency}/{dsd_id}/{version}?references=all` → dimensions + all codelists
- Data: `GET /external/sdmx/3.0/data/dataflow/{agency}/{flow}/{version}/{key}?startPeriod=&endPeriod=` → SDMX-JSON observations
- Key format: dot-separated dimension codes in DSD order (e.g. `USA.NGDP_RPCH.A` for WEO; `USA.CPI._T.PCH.A` for CPI)
- Dimension codes are positional — order is defined per-DSD, not globally uniform across dataflows
- Country codes are ISO 3-letter (USA, GBR, DEU, …), not ISO 2-letter
- Observations returned in compact SDMX-JSON format: indexed by position (e.g. `"0":["-0.257"]`) requiring resolution against `structures[0].dimensions.observation[0].values` for time labels
- Attribute data carried per-series (SCALE, DECIMALS_DISPLAYED, UNIT, IFS_FLAG) and per-observation (STATUS, PRECISION) — the series-level ids are not uniform across the catalog (see decision 15)
- DataCanvas (DuckDB) for large analytical result sets — opt-in via `CANVAS_PROVIDER_TYPE=duckdb`; table-level cleanup is separately opt-in via `IMF_ENABLE_DATAFRAME_DROP=true`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ImfSdmxService` | `api.imf.org` SDMX 3.0 REST API | `imf_list_databases`, `imf_get_database`, `imf_query_dataset`, `imf://database/{dataflow_id}` |
| Canvas accessor | `DataCanvas` from mcp-ts-core | `imf_query_dataset`, `imf_dataframe_describe`, `imf_dataframe_query`, `imf_dataframe_drop` |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No (default: `none`) | Set to `duckdb` to enable DataCanvas for large query result spill. Requires `@duckdb/node-api` peer dep. |
| `IMF_ENABLE_DATAFRAME_DROP` | No (default: `false`) | Set to `true` to register the destructive `imf_dataframe_drop` table-cleanup tool. |
| `IMF_BASE_URL` | No (default: `https://api.imf.org/external/sdmx/3.0`) | Override base URL for testing or proxied environments. |
| `IMF_REQUEST_TIMEOUT_MS` | No (default: `30000`) | Per-request timeout in milliseconds. IMF SDMX 3.0 responses can be slow on large dataflows. |

---

## Implementation Order

1. **Config and server setup** — `src/config/server-config.ts` with `IMF_BASE_URL`, `IMF_REQUEST_TIMEOUT_MS`; canvas accessor wired in `setup()`
2. **ImfSdmxService** — `fetchDataflows()`, `fetchDataStructure()`, `fetchData()` with retry, timeout, SDMX-JSON parse; dimension key builder; observation decoder (position index → time label)
3. **`imf_list_databases`** — list + name-filter, paged with `limit`/`offset` and shortened descriptions (the full catalog does not fit a single response worth spending)
4. **`imf_get_database`** — DSD fetch with `?references=all`; dimensions + codelists; local name→code resolution; optional dataflow-wide availability projection
5. **`imf_query_dataset`** — key validation, data fetch, observation decode, spillover for large results
6. **`imf_dataframe_describe` + `imf_dataframe_query` + `imf_dataframe_drop`** — canvas inspection, bounded SQL, and opt-in table cleanup (no-op when canvas disabled)
7. **`imf://database/{dataflow_id}` resource** — DSD fetch + bounded codelist discovery, stable URI

Each step is independently testable.

---

## Domain Mapping

| Noun | Operations | Notes |
|:-----|:-----------|:------|
| Dataflow | list (full catalog), get (structure + codelists) | Discovery surface |
| Dimension | list per dataflow, resolve code by name | Part of `imf_get_database` |
| Codelist | fetch per DSD dimension | Returned inline in `imf_get_database` |
| Observation | fetch by dimension key + time range | `imf_query_dataset` |
| Canvas table | register (spill), describe, query, drop | `imf_query_dataset` + dataframe trio |

---

## Workflow Analysis

**`imf_query_dataset` upstream call sequence:**

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /structure/dataflow` (cached) | Validate dataflow_id exists; get agencyID + version if not provided |
| 2 | `GET /structure/datastructure/{agency}/{dsd}?references=all` (cached) | Get dimension order for key validation; get time-period codelist for observation decoding |
| 3 | `GET /data/dataflow/{agency}/{flow}/{version}/{key}?startPeriod=&endPeriod=` | Fetch observations |
| 3b | `GET /data/dataflow/.../{key with one position widened to `*`}?attributes=series&measures=none` (conditional) | Recover a dimension-group attribute a `+` key suppressed upstream (decision 17) |
| 4 | Observation decode | Map positional indices to time labels via `structures[0].dimensions.observation[0].values` |
| 5 | Placement + final-result budget | Explicitly stage when requested, otherwise spill an oversized analytical result; size the complete MCP result envelope and rebalance only the observation preview |

Steps 1–2 are cache candidates (DSD rarely changes; dataflow list changes when IMF publishes new vintages). Step 3 is always live. Step 3b runs only for the response shape it can repair — a `+` key whose group came back empty — so every other query stays at one data request, and its failure leaves the query exactly as step 3 answered it.

---

## Design Decisions

### 1. Access model: `api.imf.org` SDMX 3.0, keyless

**Confirmed via live probing (2026-06-05):**

| Endpoint | Status | Notes |
|:---------|:-------|:------|
| `http://dataservices.imf.org/REST/SDMX_JSON.svc/` | **DEAD** — DNS does not resolve | The legacy endpoint cited in most IMF API client documentation is gone |
| `https://sdmxcentral.imf.org/ws/public/sdmxapi/rest/` | **Partially working** — structure endpoints return XML, but data endpoints return "No Results Found" | Structures-only, not a data source |
| `https://api.imf.org/external/sdmx/3.0/` | **Working, keyless** — all tested endpoints return 200 without auth | The current canonical endpoint |

The `api.imf.org` portal does not require registration for data queries. All dataflows, datastructures with codelists, and observations are accessible without credentials.

**SDMX surface on `api.imf.org`:** The new portal does not carry the legacy `IFS` (International Financial Statistics) monolithic database. IFS has been decomposed into topic-specific dataflows: `CPI` (Consumer Price Index), `ER` (Exchange Rates), `IL` (International Liquidity / reserves), `MFS_*` (Monetary and Financial Statistics components), `IIP` (International Investment Position). This is a richer structure — each sub-database has its own DSD with tailored dimensions — but agents need `imf_list_databases` + `imf_get_database` to navigate it, since the legacy "IFS → indicator code" mental model no longer applies.

**IFS legacy name in server description and tool descriptions:** the `IFS` legacy acronym should not appear as a database code; refer to its constituent databases by name.

### 2. DataCanvas: adopted

IMF macro data is inherently analytical — multi-country GDP comparisons, BOP time series, WEO cross-country projections. An agent querying 30 countries × 5 indicators × 20 years = 3,000 observations is exactly the "agent would run `GROUP BY country`" shape that earns a canvas. DataCanvas is adopted. Automatic placement measures the actual MCP success result (`structuredContent` plus rendered `content[]`, including enrichment trailers) and stages only when that result exceeds 100,000 serialized characters. Series metadata, handles, attribution, guidance, and truthful `observation_count` are fixed; the observation preview is reduced to meet the cap. If those fixed fields alone exceed the budget, the tool returns `response_too_large` and asks the caller to narrow the series key rather than silently dropping metadata.

The `canvas_id` from `imf_query_dataset` is reachable via `imf_dataframe_query` and `imf_dataframe_describe`; opt-in `imf_dataframe_drop` reclaims one completed table without deleting unrelated tables or invalidating the canvas.

### 3. Key format: dimension-positional, DSD-local

SDMX dimension keys are ordered by the DSD's `keyPosition` values, which differ per dataflow. WEO uses `COUNTRY.INDICATOR.FREQUENCY`; BOP uses `COUNTRY.BOP_ACCOUNTING_ENTRY.INDICATOR.UNIT.FREQUENCY`; CPI uses `COUNTRY.INDEX_TYPE.COICOP_1999.TYPE_OF_TRANSFORMATION.FREQUENCY`. The key format is not documented on-screen — it's latent in the DSD.

**Consequence for UX:** `imf_get_database` must return the dimension order explicitly (e.g. `"key_format": "COUNTRY.INDICATOR.FREQUENCY"`) so agents can construct keys without re-fetching the DSD. The tool description should state that `imf_get_database` is mandatory before querying.

### 4. Observation decoding: positional index → time label

The SDMX-JSON compact format encodes observations as `{ "0": ["-0.257"], "1": ["2.537"], ... }` where the index is a position into `structures[0].dimensions.observation[0].values`. The decoded time label (e.g. `"2018"`, `"2023-Q2"`) must be resolved from this array. The service layer handles this; the tool returns `{ time_period, value, status }` objects, not raw indices.

### 5. Country codes: ISO 3-letter, not ISO 2-letter

Confirmed from codelist probing: `USA` not `US`, `GBR` not `GB`, `DEU` not `DE`. The `imf_get_database` tool must surface this prominently — models default to ISO 2-letter.

### 6. Vintage dataflows excluded from primary surface

The portal exposes 70+ `_VINTAGE` dataflows (e.g. `WEO_2025_OCT_VINTAGE`, `CPI_2026_APR_VINTAGE`). These are point-in-time snapshots used for reproducibility. `imf_list_databases` filters them out by default (opt-in via `include_vintages: true` flag) to keep the discovery surface clean.

### 7. `format()` completeness requirement

`imf_query_dataset` has two output paths (inline observations vs. canvas spill) — both must be content-complete in `format()`:

- **Inline path:** render `start_period`–`end_period` context, unit/scale, and observations as a markdown table. `staged: false` and `truncated: false` describe the default under-budget result.
- **Canvas path:** render the canvas handle summary — `canvas_id`, `table_name`, `observation_count`, `staged`, and `truncated` — plus instructions for follow-up (`imf_dataframe_describe` → `imf_dataframe_query`). The same instructions are carried in `structuredContent.retrieval_guidance`; when an unparsed-period `notice` also applies, both fields and both content blocks are returned together.

`imf_get_database` format: render `key_format` prominently (first line), then each dimension with its codelist or availability entries and page counts. Every preview is bounded at 50; a selected `dimension_id` can use `limit`/`offset`, and `next_offset` names the continuation call. Availability mode also renders series/time coverage and per-dimension available counts. A dimension with no entries distinguishes filter miss, offset past the end, unresolved codelist, and no published coverage.

### 8. Caching strategy

- Dataflow list: cache 1 hour — changes only when IMF publishes new releases
- DSD + codelists: cache 24 hours per `(agency, dsd_id, version)` — rarely changes within a version
- Full dataflow availability: cache 1 hour per dataflow — reused across preview and selected-dimension pages
- Data observations: no cache — always live
- MCP metadata responses: public one-hour cache hints on all six cacheable 2026-07-28 operations (`tools/list`, `prompts/list`, `resources/list`, `resources/templates/list`, `resources/read`, `server/discover`); 2025 responses are unchanged

Use `ctx.state` for in-process per-tenant caching; TTL-backed via the `ttl` option on `ctx.state.set`.

### 9. Period bounds are date spans, compared by overlap

A period label names an interval, not an instant: `2023` is January–December, `2023-Q1` is January–March. Both bounds resolve to the span of dates they name, and an observation is kept when its own span overlaps `[start.lo, end.hi]`.

Comparing normalized label *strings* instead — the earlier approach — made the two bounds behave differently at the same granularity gap: `start_period: "2023"` admitted `2023-M01` because `"2023" <= "2023-01"`, while `end_period: "2023"` rejected it because `"2023-01" > "2023"`, dropping every month of the final year.

Overlap rather than containment for the reverse case (a bound finer than the data, e.g. quarterly bounds against annual observations): containment would silently drop the observation straddling the bound, which is the same class of quiet data loss the change exists to remove. Overlap also makes `start_period` and `end_period` symmetric, and a range that genuinely selects nothing is now diagnosed rather than misreported (decision 10).

The same spans back input validation: a range is reversed only when `start.lo > end.hi`, so a mixed-granularity forward range (`start_period: "2023-Q2"`, `end_period: "2023"`) is accepted rather than read as reversed.

Spans are keyed on dates rather than months because not every frequency the portal publishes is monthly or coarser. The recognized label set is derived from the portal rather than assumed: sweeping the `FREQUENCY` availability constraint over every dataflow in the catalog turns up five codes with data — `A`, `S`, `Q`, `M`, `D` — emitting `2023`, `2023-S1`, `2023-Q1`, `2023-M01`, and `2023-01-05` respectively. `PIP` is the semi-annual flow; `IRFCL` and `CCI` are the daily ones. (`CL_FREQ` also enumerates `W`, `H`, `B` and others; no dataflow publishes them, and the flows the constraint reports nothing for return no series either.) A date key is the plain integer `YYYYMMDD` — ordering is the only operation the comparison performs, so the closing edge of a month, quarter, half-year, or year is day 31 with no calendar lookup: no real date inside that month sorts above it and none in the next month sorts below.

An unparsed label is kept rather than filtered, because dropping data over an unrecognized label shape is worse than ignoring the bound for it. Left silent, though, that fallback reproduces exactly the loss the string comparison caused — the response echoes a range it did not apply. So the success path carries a `notice` naming how many observations were returned unfiltered and a sample of their labels, and a shape the portal adds later surfaces instead of quietly widening a range.

### 10. `no_data` distinguishes coverage from range

Two unrelated causes used to share one reason. Period filtering is client-side, so a valid key with a non-overlapping range emptied the result *after* the fetch and was reported as `no_data` — whose availability enrichment then listed the caller's own codes as the ones that do have data, refuting the diagnosis it accompanied.

The handler now checks the pre-filter observation count. Non-empty before filtering and empty after is `no_data_in_range`: it reports the requested range, the range the response actually spans, and the count excluded, and skips the availability probe entirely (both a wasted round-trip and a misleading answer for a range problem). `no_data` keeps the coverage diagnosis and the enrichment, for a key the dataflow genuinely has no series for.

### 11. Query recovery availability discloses its own listing cap

The `no_data` enrichment is a bounded diagnostic on the query failure path. Its separate `AvailabilityResult` parser keeps a 20-code cap so an error stays compact, but an unannotated slice presents itself as the complete set, so a caller that does not find its own valid code in the list concludes the code is uncovered. The opt-in `imf_get_database available_only=true` discovery path uses a separate uncapped parser and cache, then bounds the full coverage through ordinary preview or selected-dimension paging; it does not widen or alter this recovery payload.

`AvailabilityDimension` therefore carries the pre-cap `count` alongside the `codes` slice, and the message states both: `INDICATOR: 20 of 46 codes with data shown (…)`. A dimension inside the cap prints its codes plain, and reads as complete because it is.

Annotating rather than suppressing the sample keeps the failure immediately useful without forcing another call. `imf_get_database available_only=true` is the continuation when the complete coverage set matters: for example, `PIP`'s `ACCOUNTING_ENTRY` codelist runs past the 50-entry preview while exactly two of its codes have data. Mid-size dimensions are the common case and the one where a sample earns its tokens: 20 of `PIP`'s 46 covered indicators is enough to spot a mistyped code, where 20 of 210 countries is not — but the annotation costs nothing in either case, and neither misleads.

### 12. Series attributes belong to a series, not to a query

`+` and `*` keys are the tool's main analytical shape, and the series they resolve to do not share attributes: in `USA.NGDPD+NGDP_RPCH.A`, `NGDPD` carries `SCALE` `9` while `NGDP_RPCH` carries the `0` sentinel. One flat `series_attributes` record therefore describes at most one of them. Attributes are decoded per series and keyed by decoded series key, and everything downstream — the inline payload, the canvas rows, the rendered table — reads them through that key, so a row can only receive its own series' unit and scale.

The output stays additive rather than redefining the existing field: `series_attributes` keeps working for the single-series case that dominates, and a query resolving to more than one series carries `series_metadata` alongside it, one entry per distinct `series_key`. A caller that never issues a multi-series key sees an unchanged response, and one that does gets a list keyed to the same `series_key` its observations carry. `series_attributes` describes the first series in that case, and its `.describe()` says so — an unlabeled "one of them" is what made the field misleading in the first place.

The precision attribute — `DECIMALS_DISPLAYED` on an IMF-authored structure, and see decision 15 for the rest — is decoded the same way as the other coded attributes. The series entry holds an index into the attribute definition's `values`, not the digit count: WEO's `[0, 0, 0, …]` against `values: [{ id: "3" }]` reads as 0 decimals for a series that displays 3. Reading it straight was reporting the index.

### 13. The formatted channel carries what the structured one does

Clients differ in which surface they forward, so an attribute present only in `structuredContent` is invisible to half of them. The `Series:` line used to be gated on a *meaningful* scale, which meant a series with the `0` sentinel and no unit rendered nothing at all — dropping `decimals` with it, and leaving a `content[]`-only client with no precision or scale information for the most common WEO shape.

The sentinel and the suppression are separable concerns. A bare `0` beside a value is genuinely misleading — it reads as an observation of zero or a multiplier of zero — but the fix for that is to name it, not to drop the line: scale `0` renders as `no scale multiplier`, and every other attribute renders beside it. `structuredContent` still carries the raw upstream code, so nothing is normalized away before the structured channel. A multi-series result renders the same facts as a per-series table instead of a single line.

The line is omitted only when the series has no attributes at all, which is the one case where there is nothing to say.

### 14. An empty dataflow is a different failure from an uncovered code

The `no_data` availability enrichment (decision 10) blamed the caller's first dimension code whenever `series_count` was 0. For a dataflow that publishes nothing — several recent `_VINTAGE` flows, reachable through `include_vintages: true` — every code produces that message, so the recovery ("try a different code") is a loop with no exit.

The discriminator is not visible in the key-scoped constraint. `availableconstraint/EER/TUR..` (an uncovered country in a dataflow holding 732 series) and `availableconstraint/CPI_2026_MAY_VINTAGE/USA..` (an empty dataflow) return the same document apart from the ids: `series_count: 0` and a `<str:CubeRegion include="true"/>` with no `KeyValue` children. An empty cube region therefore distinguishes nothing.

The dataflow-wide constraint does. `availableconstraint/{flow}/` reports the flow's own series count — 732 for `EER`, 0 for `CPI_2026_MAY_VINTAGE` — and, when non-zero, a cube region naming codes that do have data. So a `series_count: 0` result triggers one further request, only on a path that already has no data to return:

| Key-scoped `series_count` | Dataflow-wide `series_count` | Diagnosis |
|--:|--:|:--|
| 0 | 0 | The dataflow is empty — recovery points at `imf_list_databases`, never at another code |
| 0 | > 0 | The code is uncovered — recovery keeps its wording and now names codes that do have data |
| > 0 | not requested | The combination is wrong (decision 10, unchanged) |

A failed second probe degrades to the previous per-code message rather than masking the diagnosis, matching how the first probe already degrades.

### 15. An attribute is located by concept, not by one id

Series attributes were located by exact id — `UNIT`, `SCALE`, `DECIMALS_DISPLAYED` — which is the convention on IMF-authored structures and only those. Structures the IMF publishes but did not author name the same facts differently, so `NA_MAIN` reported `unit`, `scale`, and `decimals` as `null` for every series while its payload carried `DECIMALS` `2` and `UNIT_MULT` `0`, and the formatted channel dropped the `Series:` line entirely for having nothing to print.

Naming the observed exceptions would have left the same defect on whatever was not sampled, so the alias sets come from the catalog rather than from the report: every dataflow's DSD attribute list, read for the ids whose `attributeRelationship.dimensions` spans the *entire* series key. A `dimensions` relationship over a proper subset of it is a different attachment level — `dimensionGroup` in the live payload, not `series` — and reading it the same way would misidentify a defect an index into the series array cannot reach (decision 16). The declared set is a superset of what any data response carries, so it bounds the problem — 222 dataflows over 214 distinct structures yield seven full-series-key spellings, tabulated under *Decoding series attributes* above, and three dataflows outside the IMF convention: `NA_MAIN`, `SDG`, `PCPS`.

`PRECISION` and `SDG`'s `UNIT_MULT` are the near misses, and both are excluded for the same structural reason: they attach to the observation, so they sit in a different list, and an index taken from one list against the other array is meaningless rather than merely wrong.

Two dataflows change what a caller sees. `NA_MAIN` reports scale `0` and 2 decimals where it reported nulls — and so renders a `Series:` line reading `no scale multiplier | 2 decimals`, its first. `SDG` reports units such as `PER_100000_POP`. `PCPS`'s `DECIMAL_DISPLAYED` is now located but carries no value upstream, so its output is unchanged until the IMF populates it.

The alias list order is precedence, IMF spelling first. It is unreachable today — no dataflow declares two spellings of one concept — and exists so one that later does resolves identically on every request instead of by whichever id its payload lists first.

### 16. An attribute is located by attachment level as well as by id

Decision 15 found every id the portal spells `unit`, `scale`, and precision with, and still left `unit` null on most of the catalog — because the ids were only ever looked for in one of the two places the portal puts them. SDMX 3.0 buckets an attribute by how much of the series key its DSD relationship names: the whole key is `series` and lives on each series' own row, a proper subset is `dimensionGroup` and lives once per group in `dataSets[0].dimensionGroupAttributes`. Of 222 dataflows, `UNIT` or `UNIT_MEASURE` is declared against a subset on 164 and against the whole key on 2 — so the bucket the decoder read was the rare one. `scale` and precision run the other way and needed no change: never `dimensionGroup`, series-attached on 218 and 215 flows.

A group key carries one colon-separated slot per declared dimension, in the same order the series key indexes and with the observation dimension last, so `WEO`'s three-dimension key produces four slots. The slots the group constrains hold an index into that dimension's `values`; the rest are empty and match anything. `":0::"` therefore reads as "INDICATOR is its first code, any country, any frequency, any period" — which is exactly what `UNIT` is declared against on `WEO`, `dimensions: ["INDICATOR"]`.

Which slots a key constrains says which *relationship* the row was filed under; it does not say which *attribute* any one cell of that row describes. Half the catalog needs that distinction: 114 dataflows file group attributes over more than one subset — `FSIBSIS` puts `UNIT` under INDICATOR and `ACCOUNTS` under SECTOR + INDICATOR, `FAS` spreads ten attributes over COUNTRY, INDICATOR, and TYPE_OF_TRANSFORMATION — so a series falls in one row per subset and several rows describe it at once. Each concept is therefore taken from the bucket its own `relationship.dimensions` selects. Reading whichever row matched instead holds only while every row leaves the cells of other relationships null, which is a property of today's payloads rather than anything the format guarantees, and its failure is a plausible unit belonging to a different set of series rather than a visible gap. The relationship is ordered against the key before it names slots, since it lists its dimensions in no particular order: `QGDP_WCA` declares one against `["TYPE_OF_TRANSFORMATION", "INDICATOR"]`, the reverse of the key order.

Group keys are indexed once by the slots they constrain, so a concept costs one keyed lookup per series however many groups or subsets the structure has. On a 40,000-series decode the dimension-group path adds roughly 10 ms over the same payload without one, and measures the same at 10 group keys as at 552 — the count `FSIBSIS` reaches against its 43,848 series.

The series bucket wins any concept both levels describe. No structure declares one at two relationships today; the order is fixed so that one which later does is described by the statement made about it alone rather than by the one made about the set it belongs to.

59 dataflows change what a caller sees, `WEO` and the regional REOs among them. `USA.NGDP_RPCH.A` reports `unit: "PT"` where it reported `null`, and a query spanning indicators gives each series its own: `USA.NGDPD.A` is `USD` at scale 9 while `USA.NGDP_RPCH.A` is `PT` unscaled. On `FSICDM`, where `UNIT` is declared against SECTOR + INDICATOR + TRANSFORMATION rather than the indicator alone, the six transformations of one distribution report separately: `USA.S12CFSI.AQ14.WQ1.Q` and its sibling quartiles are `PT` while `USA.S12CFSI.AQ14.WGTK.Q`, the kurtosis, is `_Z`. The other 105 declare a dimension-group unit their payloads never populate (see Known Limitations).

### 17. A group the portal ships empty is recovered by an attributes-only request

Decision 16 reads whatever the payload carries, and the portal does not always carry it. A key that combines codes with `+` on the very dimension a group is declared against, with no position using `*`, comes back with that group's definition holding no `values` at all — so nothing indexes, and `WEO`'s `USA.NGDP_RPCH+NGDPD.A` reported no unit for either series while `USA.NGDP_RPCH+NGDPD.*` reported `USD` and `PT` for the same two. Two spellings of one query disagreeing, with nothing in either response saying which is right, is worse than the missing value.

Nothing in the response can be repaired, so the values have to be asked for again in a shape the portal answers. Two request parameters and one request decide what that costs, and each was measured against the live portal rather than reasoned about:

| Approach | `WEO` `USA.NGDP_RPCH+NGDPD.A` | `PPI` `USA.PPI.POP_PCH_PT+IX.A` |
|:--|--:|--:|
| Re-request with a position widened to `*`, filter locally | +6,589 B | +120,839 B |
| Split the `+` list into one request per code | 2 requests, 10,654 B | 2 requests, 13,649 B |
| Widen a position, `attributes=series&measures=none` | **+6,540 B** | **+4,045 B** |

`measures=none` drops the observation values and `attributes=series` drops the observation-attached attribute rows, which is what separates the last row from the first: `measures=none` alone still returns a row per period wherever a dataflow carries observation attributes, and on `PPI` that is 85 KB rather than 4 KB. Narrowing the period window — the obvious way to shrink a data response — does nothing here at all: the portal ignores `startPeriod` and `endPeriod` (see Known Limitations), which is also why this server filters ranges locally. `dimensionAtObservation=AllDimensions` inflates the same query to 972 KB, and the SDMX `c[DIM]=` component filters are accepted and ignored, so a widened position cannot be constrained back.

Which position is widened is the whole cost. Any `*` restores the values, and on `WEO` the choice runs from 6.5 KB for FREQUENCY to 80 KB for INDICATOR and 220 KB for COUNTRY; on `GFS_BS`, COUNTRY reaches 2 MB over 17 seconds. The probe therefore widens the position with the smallest codelist, excluding the dimensions the suppressed group is declared against, since widening one of those multiplies the group rows themselves. Codelist sizes come from the DSD, which the query has already fetched and cached. Across all 163 dataflows that declare a dimension-group unit, that rule picks a codelist of at most 34 codes — the frequency dimension on 109 of them and a narrow indicator or transformation dimension on the rest — which is what holds a probe to kilobytes: over a literal key it measured 1.7–6.5 KB, and a deliberately wide 30-country `+` list on `CPI` reached 32 KB.

The two responses index their `values` lists independently — `PPI` returns TYPE_OF_TRANSFORMATION as `["IX", "POP_PCH_PT"]` for one key and the reverse for the other — so a recovered value is carried by the codes its group names, never by the slot indices it arrived under. Rows are matched to concepts exactly as decision 16 matches them: by the slots the attribute's own relationship names, so a probe row filed under a different subset cannot answer for it. The widened position is never a group dimension, so the probe's group rows cover exactly the code combinations the original key named — a widened response is broader in series but not in groups. Checked against per-series ground truth across 26 dataflows and 52 series, every recovered unit matched what the same series reports on its own literal key, `FSICDM`'s three-dimension relationship (`WQ1` → `PT`, `WGTK` → `_Z`) and `QGDP_WCA`'s reversed one included.

It fires only for the shape it can fix, and an empty group is not by itself that shape. Four conditions hold together: a declared group with empty `values`; a key that combines codes with `+` at a position the group is declared against; no `*` already in the key (a key that has one is already the shape the probe would build); and a response with series to annotate. The `+` clause is what keeps the probe off ordinary traffic. Around a hundred dataflows declare a unit and publish none, and their responses carry the same empty group a suppressed one does — so keying on the empty group alone spends a request on every query against them and always ends in the same `null`: over a literal single-code key per flow, that fired on 35 of the 65 flows that returned series and recovered a value on none of them. Their `*` form ships the group empty too, so no second request could have helped. Requiring the `+` drops no recovery, because it is the portal's own trigger — across 30 dataflows that do populate the group, a `+` on any dimension outside it left the values intact (`USA+GBR.NGDP_RPCH.A` resolves normally) and a `+` on one inside it emptied them every time, down to a degenerate `NGDPD+NGDPD`. With all four in force, every query the portal answers completely costs exactly one upstream request.

Everything about the probe is bounded and optional: one GET, never retried, its own 10-second cap, and every failure path — non-200, unparseable body, timeout, a structure that will not resolve — returning what the query returned before it existed. It sits on the success path of a working query, so it may add a unit but never an error. Measured live, it adds ~0.25 s to an affected query and nothing at all to an unaffected one.

---

## Known Limitations

- **No `IFS` monolithic database.** The legacy IFS (exchange rates, reserves, money, prices, interest rates in one cube) no longer exists on `api.imf.org`. Equivalent data exists in component databases: `ER`, `IL`, `CPI`, `MFS_*`. Agents migrating from legacy IMF client code will need to update their database codes.
- **Empty series on bad keys.** A dimension key with unknown codes returns HTTP 200 with an empty dataset (`series` absent from the dataset) rather than a 4xx error. The service layer must detect this and surface it as a `no_data` error carrying availability context. An empty key segment behaves the same way upstream, so it is rejected locally as `empty_key_segment` rather than sent and misreported.
- **Shared DSDs list every flow that references them.** A `?references=all` DSD payload carries each dataflow sharing the structure, in an order the portal does not hold stable — `DSD_GFS` has returned different flows first across requests. Nothing on the payload marks which flow was asked for, so a flow's own identity (`name`, `version`, `agencyId`, `description`) is taken from the dataflow catalog entry, never from the structure payload's flow list.
- **WEO forecast vs. historical.** WEO observations mix historical actuals and projections in a single series. The API does not flag which observations are projections vs. actuals; the `DERIVATION_TYPE` observation attribute carries this when present.
- **SDMX 3.0 rate limits.** IMF has not published explicit rate limits for the SDMX 3.0 portal. Live testing showed no rate limiting on sequential requests, but large multi-country queries can be slow (2–10 seconds). Build with a 30-second timeout and 3-attempt retry with exponential backoff.
- **Some dataflows declare a unit and ship no value for it.** Both attachment levels are decoded (decision 16), but a structure can declare `UNIT`, leave its `values` empty and omit `dimensionGroupAttributes` altogether — `CPI` does this for every key shape, as do `QNEA`, `MFS_*`, `IRFCL` and a long tail, and `AEA` does the same for its series attribute. `unit` is `null` there because the portal carries nothing to report, not because the decode misses it. 59 of the 164 flows that declare a dimension-group unit actually populate it.
- **A `+` key suppresses dimension-group attributes upstream; the values are recovered by a second request.** When a key combines codes with `+` on the very dimension a group is declared against and no position uses `*`, the portal ships that group's definition with empty `values` — `WEO`'s `USA.NGDP_RPCH+NGDPD.A`, which also omits `dataSets[0].dimensionGroupAttributes` altogether, and `PPI`'s `USA.PPI.POP_PCH_PT+IX.A`, which keeps the block and files only other groups' rows in it. A `+` on any other dimension is unaffected (`USA+GBR.NGDP_RPCH.A` resolves normally), and so is a key with no `+` at all. The response cannot be repaired after the fact, so a probe request recovers the values (decision 17) and both key shapes report the same unit. The dataflows that declare a unit and publish none return the identical empty group for every key, so the probe is gated on the `+` as well and never fires for them.
- **`startPeriod` and `endPeriod` are ignored by the portal.** They are sent, and the response carries every observation the key has — `USA.NGDP_RPCH.A?startPeriod=2023&endPeriod=2023` returns all 52. The range filter is applied locally as a result, and a period bound cannot be used to make an upstream request smaller.

---

## API Reference

### Base URL

```
https://api.imf.org/external/sdmx/3.0
```

No authentication required. No API key header needed.

### Endpoint Patterns

| Operation | Path Pattern | Example |
|:----------|:-------------|:--------|
| List all dataflows | `GET /structure/dataflow` | `/structure/dataflow` |
| Get datastructure + codelists | `GET /structure/datastructure/{agency}/{dsd_id}/{version}?references=all` | `/structure/datastructure/IMF.RES/DSD_WEO/9.0.0?references=all` |
| Data query | `GET /data/dataflow/{agency}/{flow_id}/{version}/{key}?startPeriod=&endPeriod=` | `/data/dataflow/IMF.RES/WEO/9.0.0/USA.NGDP_RPCH.A?startPeriod=2018&endPeriod=2026` |

### Key Database Reference

| Database | Dataflow ID | Agency | DSD | Key Format | Notes |
|:---------|:------------|:-------|:----|:-----------|:------|
| World Economic Outlook | `WEO` | `IMF.RES` | `DSD_WEO` | `COUNTRY.INDICATOR.FREQUENCY` | Biannual; mix of actuals + projections |
| Balance of Payments | `BOP` | `IMF.STA` | `DSD_BOP` | `COUNTRY.BOP_ACCOUNTING_ENTRY.INDICATOR.UNIT.FREQUENCY` | Current/capital/financial accounts |
| International Investment Position | `IIP` | `IMF.STA` | `DSD_BOP` (shared) | `COUNTRY.BOP_ACCOUNTING_ENTRY.INDICATOR.UNIT.FREQUENCY` | Shares DSD with BOP |
| Exchange Rates | `ER` | `IMF.STA` | `DSD_ER_PUB` | varies | Bilateral and effective |
| Consumer Price Index | `CPI` | `IMF.STA` | `DSD_CPI` | `COUNTRY.INDEX_TYPE.COICOP_1999.TYPE_OF_TRANSFORMATION.FREQUENCY` | ~90 countries; HICP for EU |
| International Liquidity (Reserves) | `IL` | `IMF.STA` | `DSD_IL` | varies | Gold, SDRs, FX reserves |
| GFS Statement of Operations | `GFS_SOO` | `IMF.STA` | varies | varies | Revenue, expenditure by government level |
| Monetary Aggregates | `MFS_MA` | `IMF.STA` | varies | varies | M1, M2, broad money |
| Global Debt Database | `GDD` | `IMF.FAD` | varies | varies | Public, private, total debt |
| Fiscal Monitor | `FM` | `IMF.FAD` | varies | varies | Fiscal balance, debt projections |
| International Trade in Goods | `ITG` | `IMF.STA` | varies | varies | Exports/imports by country |
| Bilateral Trade (by partner) | `IMTS` | `IMF.STA` | varies | varies | Direction of trade |
| COFER (Reserve Currency Composition) | `COFER` | `IMF.STA` | varies | varies | USD/EUR/etc. share of global reserves |

### Key Syntax

- Codes are dot-separated, one per dimension, in DSD `keyPosition` order — every position present, none blank
- `*` wildcards a position (`USA.CPI._T.*.M` → 6 series where `USA.CPI._T.IX.M` → 1); `+` combines codes at one position (`USA+GBR.NGDP_RPCH.A`)
- An empty segment is **not** a wildcard: `USA.CPI._T..M` returns HTTP 200 with zero series upstream
- Country codes are **ISO 3-letter** (USA, GBR, DEU, JPN, CHN, …)
- Frequency codes with data anywhere in the catalog: `A` = annual (`2023`), `S` = semi-annual (`2023-S1`), `Q` = quarterly (`2023-Q1`), `M` = monthly (`2023-M01`), `D` = daily (`2023-01-05`). `CL_FREQ` enumerates more (`W`, `H`, `B`, …); no dataflow publishes them

### Response Shape (Compact SDMX-JSON)

```json
{
  "data": {
    "dataSets": [{
      "structure": 0,
      "action": "Replace",
      "series": {
        "0:0:0": {
          "attributes": [null, null, null, "9/30/2025"],
          "observations": {
            "0": ["-0.257"],
            "1": ["2.537"],
            ...
          }
        }
      }
    }],
    "structures": [{
      "dimensions": {
        "series": [
          { "id": "COUNTRY", "values": [{ "id": "USA", "name": "United States" }] },
          { "id": "INDICATOR", "values": [{ "id": "NGDP_RPCH", "name": "GDP, Constant prices, Percent change" }] },
          { "id": "FREQUENCY", "values": [{ "id": "A", "name": "Annual" }] }
        ],
        "observation": [
          { "id": "TIME_PERIOD", "values": [{ "id": "1980" }, { "id": "1981" }, ...] }
        ]
      }
    }]
  }
}
```

**Decoding observations:** Series key `"0:0:0"` = indices into each series dimension's `values` array. Observation key `"0"` = index into `structures[0].dimensions.observation[0].values` → time label. Observation value `["-0.257"]` = `[OBS_VALUE, ...attribute_values]` (attribute order from `structures[0].attributes.observation`).

**Decoding series attributes:** a series' `attributes` array is positional against `structures[0].attributes.series`, and each entry is an *index* into that definition's `values` — not the value. `SCALE` `[{ id: "9" }, { id: "0" }]` with an entry of `0` means scale 9, and `DECIMALS_DISPLAYED` `[{ id: "3" }]` with an entry of `0` means three decimals. An attribute definition that ships no `values` (e.g. `COUNTRY_UPDATE_DATE`) carries its literal inline instead, so the decode resolves through `values` when present and falls back to the raw entry when not. Every series in a multi-series response points into the same definition list at different indices — which is why the attributes are per series.

**Series attribute ids.** Which id names unit, scale, or precision depends on who authored the structure. A sweep of every dataflow's DSD attribute list (222 dataflows over 214 distinct structures) found seven series-attached spellings across the three concepts:

| Decoded attribute | Ids, in precedence order | Structures declaring the non-primary id |
|:--|:--|:--|
| `unit` | `UNIT`, `UNIT_MEASURE` | `SDG` (IAEG-SDGs) |
| `scale` | `SCALE`, `UNIT_MULT` | `NA_MAIN` (ESTAT) |
| `decimals` | `DECIMALS_DISPLAYED`, `DECIMALS`, `DECIMAL_DISPLAYED` | `NA_MAIN` (`DECIMALS`), `PCPS` (`DECIMAL_DISPLAYED`) |

`PRECISION` (205 structures) and `SDG`'s `UNIT_MULT` attach to the observation, not the series, so they never appear in the list these indices are taken against. No dataflow declares two spellings of one concept, so the precedence order is a tie-break that does not fire today.

**Decoding dimension-group attributes.** An attribute whose DSD relationship names a proper subset of the series-key dimensions is not on any series' row. It sits in `structures[0].attributes.dimensionGroup`, and its values in `dataSets[0].dimensionGroupAttributes`, keyed by a partial dimension key:

```json
{
  "dataSets": [{
    "dimensionGroupAttributes": {
      ":0::": [null, null, 0, null, null, null, null, null, null, null, null, 0, null, null, null, 0, null]
    }
  }],
  "structures": [{
    "attributes": {
      "dimensionGroup": [
        { "id": "FUNCTIONAL_CAT", "relationship": { "dimensions": ["INDICATOR"] }, "values": [] },
        "…",
        { "id": "UNIT", "relationship": { "dimensions": ["INDICATOR"] }, "values": [{ "id": "PT" }] }
      ]
    }
  }]
}
```

The key has one slot per declared dimension — series dimensions in `dimensions.series` order, then the observation dimension — so `WEO`'s `COUNTRY.INDICATOR.FREQUENCY` plus `TIME_PERIOD` gives the four slots of `":0::"`. A slot the group constrains holds an index into that dimension's `values`; every other slot is empty and matches any code. Slot 1 of `":0::"` is INDICATOR's first code, which is what pairs the row with `USA.NGDP_RPCH.A`. Each row is positional against the `dimensionGroup` definition list exactly as a series' `attributes` array is against `series`, so position 15 of the row above is `UNIT`'s entry, an index into its `values` → `"PT"`.

Keys filed under different relationships share one map, so the mask alone does not say which attribute a cell belongs to. `FAS` files 184 keys constraining COUNTRY, 172 constraining INDICATOR, and 12 constraining TYPE_OF_TRANSFORMATION into the same object; a series matches one of each, and `UNIT`'s value is the one in the TYPE_OF_TRANSFORMATION row because that is the relationship `UNIT` declares. Each concept is looked up in the bucket its own relationship names, with the relationship's dimensions ordered against the key first — `QGDP_WCA` lists one of its relationships as `["TYPE_OF_TRANSFORMATION", "INDICATOR"]`, positions 2 and 1, which name slots `[1, 2]` only once sorted.

| Attribute | Ids, in precedence order | Flows declaring it in `dimensionGroup` | Flows whose payload populates it |
|:--|:--|--:|--:|
| `unit` | `UNIT`, `UNIT_MEASURE` | 164 | 59 |
| `scale` | `SCALE`, `UNIT_MULT` | 0 | — |
| `decimals` | `DECIMALS_DISPLAYED`, `DECIMALS`, `DECIMAL_DISPLAYED` | 0 | — |

The bucket carries far more than the three decoded concepts — `TRANSFORMATION` (143 flows), `SECTOR` (84), `ACCOUNTING_ENTRY` (69), `INDEX_TYPE` (54), `VALUATION` (52) and a long tail — none of which the tool surfaces.

### Error Patterns

| Condition | HTTP | Body |
|:----------|:-----|:-----|
| Unknown dataflow | 404 | `{ "statusCode": 404, "message": "Resource not found" }` |
| Bad dimension key (unknown code) | 200 | Empty dataset — `dataSets[0]` has no `series` key |
| No data for valid key + time range | 200 | Empty dataset — `dataSets[0]` has `dimensionGroupAttributes` but no `series` |
| Invalid SDMX path structure | 404 | `{ "statusCode": 404, "message": "Resource not found" }` |
