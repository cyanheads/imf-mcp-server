# imf-mcp-server — Design

## MCP Surface

### Tools

| Name | Description | Key Inputs | Annotations |
|:-----|:------------|:-----------|:------------|
| `imf_list_databases` | List all IMF SDMX dataflows available on the portal. Returns id, agencyID, version, name, description. Entry point — every query requires a dataflow id. | `filter` (optional name substring), `include_vintages` (bool, default false) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `imf_get_database` | Fetch a dataflow's dimension list plus a codelist preview for each dimension — first 50 entries by default, every substring match when `codelist_filter` is set, and complete codelists from the `imf://database/{dataflow_id}` resource. Resolves human terms to SDMX codes ("United States" → USA, "real GDP growth" → NGDP_RPCH). Mandatory before querying — SDMX keys are opaque without codelist lookups. | `dataflow_id`, `agency_id` (optional, auto-detected), `version` (optional), `codelist_filter` (optional substring) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `imf_query_dataset` | Query a dataflow by dimension key (dot-separated codes, e.g. `USA.NGDP_RPCH.A`) over a time range. Returns observations with time, value, unit, scale, and status attributes. Large analytical result sets spill to DataCanvas for SQL — returns `canvas_id` + `table_name`. | `dataflow_id`, `agency_id`, `version`, `key` (dimension key), `start_period`, `end_period`, `canvas_id` (optional) | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: true` |
| `imf_dataframe_describe` | List DataCanvas tables and columns staged by a prior `imf_query_dataset` call. Shows table name, row count, and column schema. | `canvas_id` | `readOnlyHint: true`, `idempotentHint: true`, `openWorldHint: false` |
| `imf_dataframe_query` | Run a read-only SQL SELECT against a staged DataCanvas table. Enables multi-country comparisons, time-series aggregation, and cross-indicator joins without hand-rolled loops. | `canvas_id`, `sql` (one SELECT statement; a leading `WITH … SELECT` CTE is accepted) | `readOnlyHint: true`, `openWorldHint: false` |

### Tool Details

#### `imf_list_databases`

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

**Output:**
- `dataflow_id`, `agency_id`, `version`, `name`, `description`
- `codelist_filter`: string, present only when a filter was applied — echoing it is what separates "your filter matched nothing" from "this codelist could not be resolved", since both render as an empty array
- `key_format`: string — dimension names in order, e.g. `"COUNTRY.INDICATOR.FREQUENCY"` (agents must see this to construct keys without re-fetching the DSD)
- `dimensions`: array of `{ id, name, position, codelist: [{ id, name }], codelist_truncated }` — `name` is the label from the DSD concept scheme (`WGT_TYPE` → `Weight Type`), falling back to the id when the structure names no concept; `codelist` is capped at 50 entries unless `codelist_filter` is set

**Enrichment:**
- `notice`: emitted when `codelist_filter` matched nothing in any dimension (names the filter and the unfiltered entry counts) or when a dimension has no resolvable codelist (names the dimensions and points at the resource). Reaches both `structuredContent` and the `content[]` trailer.

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
  { reason: 'structure_unavailable', code: ServiceUnavailable,
    when: 'api.imf.org returns non-200 on the DSD endpoint',
    recovery: 'Retry after a short wait; the IMF SDMX 3.0 portal is occasionally slow.' },
  { reason: 'dataflow_list_unavailable', code: ServiceUnavailable, retryable: true,
    when: 'The dataflow catalog that dataflow_id is resolved against could not be fetched',
    recovery: 'Retry in a few moments; the catalog is cached for an hour once it succeeds.' },
]
```

---

#### `imf_query_dataset`

**Input constraints:**
- `key`: string — dot-separated dimension codes in DSD `keyPosition` order, one segment per dimension. Use `+` to combine codes at one position (e.g. `USA+GBR.NGDP_RPCH.A`) and `*` to match every code at a position (e.g. `*.NGDP_RPCH.A`). Every position needs a code or a `*`; a blank segment (`USA..A`) is rejected as `empty_key_segment`, and an omitted position is rejected as `key_dimension_mismatch`. Country codes are ISO 3-letter (USA, not US). Call `imf_get_database` first to obtain the correct `key_format` and valid codes.
- `start_period` / `end_period`: string — `YYYY` (annual), `YYYY-SN` (semi-annual), `YYYY-QN` (quarterly, e.g. `2023-Q1`), `YYYY-MM` (monthly), or `YYYY-MM-DD` (daily), independent of the dataflow's own frequency. Every label the portal emits is also accepted as a bound, so an observation's `time_period` round-trips. Omit either to use the full available range. Malformed values and reversed ranges are rejected before the upstream call.

**Output (inline, no canvas spill):**
- `dataflow_id`, `key`, `start_period`, `end_period`
- `observations`: array of `{ time_period: string, value: number | null, status: string | null }`
- `series_attributes`: `{ unit: string | null, scale: string | null, decimals: number | null }`
- `observation_count`: number
- `truncated`: boolean (true when result was trimmed to preview budget; set `canvas_id` to retrieve full set)

**Output (canvas spill):**
- `canvas_id`: string — pass to `imf_dataframe_query` / `imf_dataframe_describe`
- `table_name`: string
- `observation_count`: number
- `truncated: true`

**Error contract:**
```
errors: [
  { reason: 'dataflow_not_found', code: NotFound,
    when: 'dataflow_id does not match any known dataflow',
    recovery: 'Call imf_list_databases to browse available dataflow IDs.' },
  { reason: 'no_data', code: NotFound,
    when: 'Key is structurally valid but the dataflow holds no series for this code combination',
    recovery: 'Check the availability context in the error — if series_count is 0 the code has no coverage; if series_count > 0 the combination is wrong and available_codes names the codes that do have data, stating how many of a dimension it is showing when the list is capped.' },
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
    recovery: 'Use YYYY (annual), YYYY-SN (semi-annual), YYYY-QN (quarterly, e.g. 2023-Q1), YYYY-MM (monthly), or YYYY-MM-DD (daily).' },
  { reason: 'invalid_period_range', code: ValidationError,
    when: 'start_period is later than end_period',
    recovery: 'Provide start_period less than or equal to end_period (chronological order).' },
  { reason: 'structure_unavailable', code: ServiceUnavailable,
    when: 'api.imf.org returns non-200 on the data endpoint',
    recovery: 'Retry after a short wait.' },
  { reason: 'dataflow_list_unavailable', code: ServiceUnavailable, retryable: true,
    when: 'The dataflow catalog that dataflow_id is resolved against could not be fetched',
    recovery: 'Retry in a few moments; the catalog is cached for an hour once it succeeds.' },
]
```

---

#### `imf_dataframe_describe` and `imf_dataframe_query`

**Error contract (both tools):**
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
]
```

Every reason the DataCanvas gate can raise on `query()` is mapped onto one of these four before it leaves the handler. The framework's own hints name `registerTable()` / `describe()`, which no MCP client can call.

**Additional constraints on `imf_dataframe_query`:**
- `sql`: one statement, starting with `SELECT` or `WITH`. The handler's `/^\s*(?:SELECT|WITH)\b/i` shape check runs *before* canvas acquisition so `invalid_sql` stays reachable when the canvas is disabled; it deliberately mirrors the framework gate's own `isSelectShaped` test. Statement typing is authoritative in the framework, which parses with DuckDB — `WITH … SELECT` types as `SELECT`, `WITH … INSERT` types as `INSERT` and is rejected.
- Output carries `truncated`. DataCanvas caps a result at the canvas row limit (default 10,000) and reports no pre-cap total, so `row_count` is the number of *materialized* rows and equals the cap when `truncated` is true. `format()` appends a paging note in the same case.

### Resources

| URI Template | Description | Pagination |
|:-------------|:------------|:-----------|
| `imf://database/{dataflow_id}` | Metadata for a single dataflow — dimensions, codelists, name, description. Stable reference for known dataflow IDs (WEO, BOP, CPI, etc.). | None (single record) |

**Resource error behavior:** throws `notFound()` when `dataflow_id` is not in the live dataflow list, and a `serviceUnavailable` carrying `reason: 'dataflow_list_unavailable'` when the catalog itself cannot be fetched. Shares `imf_get_database`'s shape (`key_format`, `dimensions`) and resolution, but returns complete codelists — no 50-entry cap and no `codelist_filter`.

### Prompts

None — this is a pure data server; no reusable message templates warranted.

---

## Overview

Global macroeconomic and financial statistics from the International Monetary Fund, accessed via the IMF's SDMX 3.0 portal (`api.imf.org`). Covers hundreds of dataflows including WEO projections, balance of payments, exchange rates, price indices, international liquidity, government finance, and national accounts for ~190 member countries.

The server follows the **discover → describe → query** workflow: `imf_list_databases` to find a dataflow id, `imf_get_database` to resolve dimension codes, `imf_query_dataset` to fetch observations. Large analytical pulls (multi-country time series) spill to a DataCanvas table for SQL via `imf_dataframe_query`.

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
- Attribute data carried per-series (SCALE, DECIMALS_DISPLAYED, UNIT, IFS_FLAG) and per-observation (STATUS, PRECISION)
- DataCanvas (DuckDB) for large analytical result sets — opt-in via `CANVAS_PROVIDER_TYPE=duckdb`

---

## Services

| Service | Wraps | Used By |
|:--------|:------|:--------|
| `ImfSdmxService` | `api.imf.org` SDMX 3.0 REST API | All tools |
| Canvas accessor | `DataCanvas` from mcp-ts-core | `imf_query_dataset`, `imf_dataframe_describe`, `imf_dataframe_query` |

---

## Config

| Env Var | Required | Description |
|:--------|:---------|:------------|
| `CANVAS_PROVIDER_TYPE` | No (default: `none`) | Set to `duckdb` to enable DataCanvas for large query result spill. Requires `@duckdb/node-api` peer dep. |
| `IMF_BASE_URL` | No (default: `https://api.imf.org/external/sdmx/3.0`) | Override base URL for testing or proxied environments. |
| `IMF_REQUEST_TIMEOUT_MS` | No (default: `30000`) | Per-request timeout in milliseconds. IMF SDMX 3.0 responses can be slow on large dataflows. |

---

## Implementation Order

1. **Config and server setup** — `src/config/server-config.ts` with `IMF_BASE_URL`, `IMF_REQUEST_TIMEOUT_MS`; canvas accessor wired in `setup()`
2. **ImfSdmxService** — `fetchDataflows()`, `fetchDataStructure()`, `fetchData()` with retry, timeout, SDMX-JSON parse; dimension key builder; observation decoder (position index → time label)
3. **`imf_list_databases`** — list + name-filter; inline preview (the full list fits)
4. **`imf_get_database`** — DSD fetch with `?references=all`; dimensions + codelists; local name→code resolution
5. **`imf_query_dataset`** — key validation, data fetch, observation decode, spillover for large results
6. **`imf_dataframe_describe` + `imf_dataframe_query`** — canvas query pair (no-op when canvas disabled)
7. **`imf://database/{dataflow_id}` resource** — DSD fetch + codelist, stable URI

Each step is independently testable.

---

## Domain Mapping

| Noun | Operations | Notes |
|:-----|:-----------|:------|
| Dataflow | list (full catalog), get (structure + codelists) | Discovery surface |
| Dimension | list per dataflow, resolve code by name | Part of `imf_get_database` |
| Codelist | fetch per DSD dimension | Returned inline in `imf_get_database` |
| Observation | fetch by dimension key + time range | `imf_query_dataset` |
| Canvas table | register (spill), describe, query | `imf_query_dataset` + dataframe pair |

---

## Workflow Analysis

**`imf_query_dataset` upstream call sequence:**

| # | Call | Purpose |
|:--|:-----|:--------|
| 1 | `GET /structure/dataflow` (cached) | Validate dataflow_id exists; get agencyID + version if not provided |
| 2 | `GET /structure/datastructure/{agency}/{dsd}?references=all` (cached) | Get dimension order for key validation; get time-period codelist for observation decoding |
| 3 | `GET /data/dataflow/{agency}/{flow}/{version}/{key}?startPeriod=&endPeriod=` | Fetch observations |
| 4 | Observation decode | Map positional indices to time labels via `structures[0].dimensions.observation[0].values` |
| 5 | Spillover check | If result is analytical + exceeds preview budget, register to DataCanvas and return handle |

Steps 1–2 are cache candidates (DSD rarely changes; dataflow list changes when IMF publishes new vintages). Step 3 is always live.

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

IMF macro data is inherently analytical — multi-country GDP comparisons, BOP time series, WEO cross-country projections. An agent querying 30 countries × 5 indicators × 20 years = 3,000 observations is exactly the "agent would run `GROUP BY country`" shape that earns a canvas. DataCanvas is adopted. The spill threshold uses `previewChars: 100_000` (~25k tokens inline; anything larger spills to DuckDB for SQL).

The `canvas_id` from `imf_query_dataset` is reachable via `imf_dataframe_query` and `imf_dataframe_describe` — no dead handles.

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

- **Inline path:** render `key_format`, `start_period`–`end_period` context, unit/scale, and the observations as a markdown table (time_period | value | status). Append a `truncated: true` notice with the suggestion to use `canvas_id` if applicable.
- **Canvas spill path:** render the canvas handle summary — `canvas_id`, `table_name`, `observation_count` — plus instructions for follow-up (`imf_dataframe_describe` → `imf_dataframe_query`). Claude Desktop clients see only `content[]`; without this, they receive no usable data on spill.

`imf_get_database` format: render `key_format` prominently (first line), then each dimension with its codelist entries as a markdown list. The codelist can be large — truncate at 50 entries per dimension and name the two ways to reach the rest (`codelist_filter`, the resource). A dimension with no entries renders one of two lines depending on whether `codelist_filter` is echoed in the result: a filter miss, or a codelist that could not be resolved.

### 8. Caching strategy

- Dataflow list: cache 1 hour — changes only when IMF publishes new releases
- DSD + codelists: cache 24 hours per `(agency, dsd_id, version)` — rarely changes within a version
- Data observations: no cache — always live

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

### 11. Availability discloses its own listing cap

The `no_data` enrichment is the caller's only view of coverage — no tool exposes the availability endpoint, and `imf_get_database` answers a different question (the code universe, not what has data). A 20-code cap keeps the message bounded, but an unannotated slice presents itself as the complete set, so a caller that does not find its own valid code in the list concludes the code is uncovered.

`AvailabilityDimension` therefore carries the pre-cap `count` alongside the `codes` slice, and the message states both: `INDICATOR: 20 of 46 codes with data shown (…)`. A dimension inside the cap prints its codes plain, and reads as complete because it is.

Annotating rather than suppressing the sample. Suppression removes the only coverage-grounded code list the caller ever sees, and the remaining route — searching `imf_get_database` — cannot answer coverage by construction: `PIP`'s `ACCOUNTING_ENTRY` codelist runs past the 50-entry preview while exactly two of its codes have data. Mid-size dimensions are the common case and the one where a sample earns its tokens: 20 of `PIP`'s 46 covered indicators is enough to spot a mistyped code, where 20 of 210 countries is not — but the annotation costs nothing in either case, and neither misleads.

---

## Known Limitations

- **No `IFS` monolithic database.** The legacy IFS (exchange rates, reserves, money, prices, interest rates in one cube) no longer exists on `api.imf.org`. Equivalent data exists in component databases: `ER`, `IL`, `CPI`, `MFS_*`. Agents migrating from legacy IMF client code will need to update their database codes.
- **Empty series on bad keys.** A dimension key with unknown codes returns HTTP 200 with an empty dataset (`series` absent from the dataset) rather than a 4xx error. The service layer must detect this and surface it as a `no_data` error carrying availability context. An empty key segment behaves the same way upstream, so it is rejected locally as `empty_key_segment` rather than sent and misreported.
- **Shared DSDs list every flow that references them.** A `?references=all` DSD payload carries each dataflow sharing the structure, in an order the portal does not hold stable — `DSD_GFS` has returned different flows first across requests. Nothing on the payload marks which flow was asked for, so a flow's own identity (`name`, `version`, `agencyId`, `description`) is taken from the dataflow catalog entry, never from the structure payload's flow list.
- **WEO forecast vs. historical.** WEO observations mix historical actuals and projections in a single series. The API does not flag which observations are projections vs. actuals; the `DERIVATION_TYPE` observation attribute carries this when present.
- **SDMX 3.0 rate limits.** IMF has not published explicit rate limits for the SDMX 3.0 portal. Live testing showed no rate limiting on sequential requests, but large multi-country queries can be slow (2–10 seconds). Build with a 30-second timeout and 3-attempt retry with exponential backoff.

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

### Error Patterns

| Condition | HTTP | Body |
|:----------|:-----|:-----|
| Unknown dataflow | 404 | `{ "statusCode": 404, "message": "Resource not found" }` |
| Bad dimension key (unknown code) | 200 | Empty dataset — `dataSets[0]` has no `series` key |
| No data for valid key + time range | 200 | Empty dataset — `dataSets[0]` has `dimensionGroupAttributes` but no `series` |
| Invalid SDMX path structure | 404 | `{ "statusCode": 404, "message": "Resource not found" }` |
