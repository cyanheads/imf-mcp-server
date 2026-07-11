# Changelog

All notable changes to this project. Each entry links to its full per-version file in [changelog/](changelog/).

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
