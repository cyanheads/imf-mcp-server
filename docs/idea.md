---
name: imf-mcp-server
description: "Global macroeconomic and financial statistics via the IMF SDMX API — International Financial Statistics, balance of payments, direction of trade, government finance, and World Economic Outlook for ~190 countries."
version: 0.0.0
status: idea
category: external-data
hosted: false
subdomain: ""
port: 0
tools: 0
resources: 0
prompts: 0
rating: unrated
stars: 0
open_issues: 0
auth: none
framework: mcp-ts-core
core_version: ""
npm: "@cyanheads/imf-mcp-server"
created: 2026-05-31
error_handling: unaudited
response_enrichment: unaudited
needs_migration: false
pattern: deep single-source
complexity: medium-high
api-deps: IMF SDMX API — legacy keyless SDMX service (dataservices.imf.org) + new SDMX 3.0 portal (api.imf.org); structures via SDMX Central
api-cost: "free data; legacy dataservices.imf.org SDMX endpoint is keyless; new api.imf.org SDMX 3.0 portal launched ~Q1 2025 and involves portal registration — confirm the access model per endpoint before building (see precondition)"
hostable: true
composes-with: worldbank-mcp-server, eurostat-mcp-server, bls-labor-mcp-server, treasury-fiscaldata-mcp-server
---

# imf-mcp-server

Global macroeconomic and financial statistics from the [International Monetary Fund](https://data.imf.org/) — the IMF's flagship statistical databases: **IFS** (International Financial Statistics), **BOP** (Balance of Payments), **DOT** (Direction of Trade Statistics), **GFS** (Government Finance Statistics), and **WEO** (World Economic Outlook) — covering ~190 member countries, much of it back to 1948.

The fleet has US-centric economics (`bls-labor`, `secedgar`, `treasury-fiscaldata`) and broad development indicators (`worldbank`, `eurostat`), but no **IMF** — the authoritative source for cross-border financial flows, exchange-rate and reserves data, balance-of-payments, and the WEO forecasts that anchor "what's projected GDP growth for country X?" The IMF is one of the canonical international-statistics providers, and it speaks SDMX — the same standard `eurostat` already uses. **See the endpoint precondition below.**

**Audience:** Economists, macro and sovereign-risk analysts, development researchers, financial journalists, fintech/policy builders, agents answering "what's country X's current-account balance?", "how have its reserves changed?", or "what does the WEO project for inflation?"

## Endpoint precondition

> ⚠️ **Confirm live access per endpoint before building.** Per the IMF's *SDMX Central Web Services Guide* (May 2025), three endpoint generations coexist:
> - **Legacy** — `dataservices.imf.org/REST/SDMX_XML.svc/` (SDMX 2.0; returns SDMX-ML 2.1 / SDMX-JSON via `?format=`). Historically **keyless** and what most existing IMF API clients (R/Python `imf` packages) still use.
> - **New SDMX 3.0 portal** — `api.imf.org/external/sdmx/3.0` (launched ~Q1 2025). The strategic, current endpoint with the fullest coverage; **involves portal registration** — verify whether data queries (vs. the swagger explorer) require auth.
> - **SDMX Central** — `sdmxcentral.imf.org/ws/public/sdmxapi/rest` (2.1) / `/sdmx/v2` (3.0). **Structures/metadata only, no data** — useful for fetching datastructures and codelists.
>
> **Recommended build path:** target the keyless legacy SDMX service for data now (proven, no-auth), pull structures from SDMX Central, and design the client to migrate to `api.imf.org` SDMX 3.0 once its access model is confirmed. Keep the SDMX abstraction in one place so the endpoint swap is a config change, not a rewrite.

## User Goals

- Get an indicator (GDP, inflation, reserves, current-account balance, exchange rate) for a country and period
- Compare a macro metric across countries or over time
- Pull balance-of-payments or direction-of-trade flows between economies
- Retrieve government finance statistics (revenue, expenditure, debt) for a country
- Look up WEO projections for headline indicators

## API Surface

IMF data is **SDMX**: each database (dataflow) is a cube of dimensions — typically **frequency** × **reference area** (country) × **indicator** × time — and every query is a dimension *key*. Codes drive everything, exactly like `eurostat`.

| Database | Code | Purpose |
|:---------|:-----|:--------|
| International Financial Statistics | `IFS` | Exchange rates, reserves, money, prices, interest rates |
| Balance of Payments | `BOP` | Current/capital/financial account flows |
| Direction of Trade Statistics | `DOT` | Bilateral export/import values |
| Government Finance Statistics | `GFS` | Revenue, expenditure, debt by government level |
| World Economic Outlook | `WEO` | Headline macro indicators + projections |

The SDMX workflow is hierarchical: discover **dataflows** (databases) → fetch the **datastructure** (the dimensions of a database) → consult the **codelists** (valid codes for each dimension) → request **data** by a dimension key (`freq.area.indicator`) with `startPeriod` / `endPeriod`. A request narrows from "everything" to "exactly this series" by how much of the key you specify.

## Tool Surface (sketch)

Prefix `imf_*`. Mirrors the `eurostat` SDMX shape — discover → resolve codes → query.

```
imf_list_databases — discover IMF databases (dataflows): IFS, BOP, DOT, GFS, WEO, and the
                     long tail, with codes and descriptions. Entry point — every query keys
                     on a database code.

imf_get_database — for a database, return its dimensions (frequency, reference area,
                     indicator, counterpart, …) and the codelist (valid codes + labels) for
                     each. Resolves human terms to SDMX codes ("United States" → US, "real
                     GDP growth" → an indicator code). Mandatory — SDMX is unusable without
                     the codes that build the dimension key.

imf_query_dataset — query a database by dimension key (freq.area.indicator[.counterpart…])
                     over a startPeriod/endPeriod range. Returns observations (time, value,
                     unit, attributes/flags). Large result sets spill to DataCanvas for SQL
                     and cross-country/time-series aggregation. The headline tool.

imf_dataframe_describe — list DataCanvas tables and columns staged by a prior
                     imf_query_dataset call (canvas_id from that response). Mirrors the
                     eia/secedgar pattern for SDMX series too large to inline.

imf_dataframe_query — run a SELECT-only SQL query against a staged DataCanvas table
                     (df_<id> handle). Enables cross-country or multi-indicator aggregation
                     without hand-rolled loops.
```

## Design Notes

- **Resolve the endpoint precondition first** (above). The architecture is otherwise clean; the only real risk is which IMF endpoint to bind to. Isolate the SDMX transport behind one adapter so legacy→3.0 migration is a swap.
- **Medium-high complexity, all from SDMX** — the dimension-key syntax (`freq.area.indicator`, dots and wildcards), mandatory code resolution, and three endpoint generations to reason about. The data model itself is regular once the codes are in hand.
- **Lean on `eurostat` prior art.** `eurostat` is already an SDMX server in the fleet — reuse its discover→describe→query tool shape and codelist-resolution UX rather than reinventing. The two should feel like siblings to an agent.
- **DataCanvas is a natural fit** — IMF series are inherently tabular (area × indicator × time); stage large pulls as tables and let agents run SQL for multi-country comparisons instead of hand-rolled aggregation. Add `imf_dataframe_describe`/`imf_dataframe_query` if the spill volume warrants it (cf. `eia`, `secedgar`).
- **Carry SDMX attributes/flags through** — observation status, base year, scale (units of millions vs. units) — dropping them silently misleads. Surface unit/scale especially; an unlabeled BOP figure is meaningless.
- **Disambiguate vs. siblings:** IMF reserves/BOP/exchange-rate data overlaps conceptually with `worldbank` development indicators — IMF is the financial/monetary authority (reserves, BOP, FX, WEO projections), World Bank the development-indicator breadth. Note which to prefer.
- Composes with `worldbank` (development indicators alongside IMF's financial view), `eurostat` (EU cross-check, shared SDMX idiom), `bls-labor` (US labor detail under IMF's global frame), `treasury-fiscaldata` (US sovereign books vs. IMF's GFS).
- Moonshot: a "country macro snapshot" workflow — for an economy, assemble GDP/inflation/current-account/reserves and the WEO projection from the right databases in one call, with the codes resolved behind the scenes.
- README one-liner: "Global macroeconomic and financial statistics from the IMF — IFS, balance of payments, trade, government finance, and the World Economic Outlook."
