# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

## [0.2.10](changelog/0.2.x/0.2.10.md) — 2026-08-06

imf_query_dataset decodes dimension-group attributes, recovering unit on WEO, CPI, and most of the catalog

## [0.2.9](changelog/0.2.x/0.2.9.md) — 2026-08-06

imf_query_dataset matches unit/scale/decimals against every id the portal spells them with, recovering values on NA_MAIN and SDG

## [0.2.8](changelog/0.2.x/0.2.8.md) — 2026-08-06

imf_list_databases pages results and shortens descriptions; imf_query_dataset keeps per-series unit/scale/decimals across structuredContent and content[], resolves DECIMALS_DISPLAYED as a coded attribute, and separates an empty dataflow from an uncovered code in no_data

## [0.2.7](changelog/0.2.x/0.2.7.md) — 2026-08-06

imf_query_dataset compares period bounds as date spans, distinguishes no_data from no_data_in_range, documents the * wildcard, and discloses the availability listing cap; imf_get_database no longer inherits a shared DSD's sibling description

## [0.2.6](changelog/0.2.x/0.2.6.md) — 2026-08-06

imf_get_database resolves codelists via enumeration URNs on IMF-authored dataflows, labels dimensions from the DSD concept scheme, and distinguishes a codelist_filter miss from an unresolved codelist

## [0.2.5](changelog/0.2.x/0.2.5.md) — 2026-08-06 · 🛡️ Security

Security fix for a dataflow-list URL leak in error responses; imf_dataframe_query surfaces DataCanvas truncation, translates missing-table recovery, and accepts WITH … SELECT; adopt @cyanheads/mcp-ts-core ^0.11.1 (TypeScript 7, raised optional-peer floors)

## [0.2.4](changelog/0.2.x/0.2.4.md) — 2026-07-11

imf_query_dataset rejects malformed and reversed start_period/end_period before the upstream call; docs/design.md error-code label corrections for key_dimension_mismatch and invalid_sql

## [0.2.3](changelog/0.2.x/0.2.3.md) — 2026-07-11

Adopt @cyanheads/mcp-ts-core ^0.10.14 with a bun install supply-chain guard; fix imf_get_database codelist resolution and dataflow identity for shared/_PUB IMF DSDs; drop stale hardcoded dataflow counts

## [0.2.2](changelog/0.2.x/0.2.2.md) — 2026-06-20

Adopt @cyanheads/mcp-ts-core ^0.10.9: DuckdbProvider.describe() binder fix, ctx.content media collector, sharper canvas SQL-gate classification; new check-dependency-specifiers devcheck step and plugin-manifest packaging checks

## [0.2.1](changelog/0.2.x/0.2.1.md) — 2026-06-12

Adopt @cyanheads/mcp-ts-core ^0.10.6: enrichment block for imf_list_databases notice, denySystemCatalogs on canvas queries, explicit name/title identity; MCPB bundle cleaner and packaging guards

## [0.2.0](changelog/0.2.x/0.2.0.md) — 2026-06-10

imf_query_dataset: server-side period filtering, null-padding removal, no_data availability enrichment; imf_get_database: codelist_filter param; description fixes

## [0.1.4](changelog/0.1.x/0.1.4.md) — 2026-06-06

Three tool fixes: SQL validation order, scale '0' suppression, empty-filter notice in structuredContent

## [0.1.3](changelog/0.1.x/0.1.3.md) — 2026-06-06

Public hosted endpoint — server.json remotes, README hosted link and client config

## [0.1.2](changelog/0.1.x/0.1.2.md) — 2026-06-05

IMF source attribution in data-returning tool output — both structuredContent and format() now carry a source field per IMF data terms

## [0.1.1](changelog/0.1.x/0.1.1.md) — 2026-06-05 · 🛡️ Security

Initial public release — 5 tools + 1 resource over IMF SDMX 3.0, DataCanvas SQL analytics, and security hardening to prevent URL leakage in error messages
