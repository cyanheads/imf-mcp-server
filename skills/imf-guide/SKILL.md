---
name: imf-guide
description: Route a macro question to the IMF dataflow that holds it and read imf_* results without mixing projections, group aggregates, or currency units. Use before calling imf_* tools for GDP, inflation, government debt, exchange rates, or cross-country comparisons, and when a catalog or codelist search finds nothing, a * key returns groups beside countries, or a long series needs splicing.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

IMF statistics for member economies and country groups: World Economic Outlook (WEO) estimates and projections, plus topic dataflows for prices, exchange rates, national accounts, balance of payments, government finance, debt, and reserves. Use it for cross-country macro comparisons and for official IMF series. WEO is annual-only, so for monthly or quarterly data go to the topic dataflow.

## Identifiers

| Identifier | Shape | Comes from |
|:--|:--|:--|
| dataflow id | `WEO`, `CPI`, `ER`, `QNEA`, `GDD` | `imf_list_databases`, or the routing table under Workflows (the catalog filter cannot find indicators; see Gates) |
| key layout | `COUNTRY.INDICATOR.FREQUENCY` in WEO; four positions in `ER`, five in `CPI`, six in `QNEA` | `key_format` from `imf_get_database`; it differs per dataflow |
| economy code | ISO 3-letter, except `KOS` (Kosovo) and `WBG` (West Bank and Gaza) | the `COUNTRY` codelist. `XKX` and `PSE` are rejected with no suggested code |
| group code | `G001` World, `G110` Advanced Economies, `G119` G7, `G120` G20, `G163` Euro Area, `G200` emerging and developing; `GX`-prefixed groups (`GX123`); `U` plus digits for UN regions (`U142` Asia) | the same `COUNTRY` codelist |
| WEO indicator | `NGDP_RPCH` real GDP growth, `NGDPD` GDP in US dollars, `PCPIPCH` CPI inflation (period average), `GGXWDG_NGDP` general government gross debt (% of GDP), `LUR` unemployment rate | `imf_get_database` with `dimension_id` `INDICATOR` and a `codelist_filter` |
| canvas id, table name | `eCEFOuYmua`, `imf_b080d325` | `imf_query_dataset`, when the result is staged |

## Gates

**The catalog filter does not search indicators.** `imf_list_databases` matches dataflow ids, names, and descriptions. `debt` returns `GDD` and `HPD` but leaves out WEO and FM, though both publish general government gross debt. Neither `reserve` nor `reserves` returns `IL`, the official reserves dataflow. Pick candidate dataflows from the routing table, then search their `INDICATOR` codelist.

**Codelist filters match fragments of IMF wording.** Each word must appear inside a code's id or name. In WEO, `consumer prices` and `inflation` both match nothing, while `consumer price` finds `PCPI`, `PCPIE`, `PCPIPCH`, and `PCPIEPCH`. Search with short singular stems in IMF terms: `price`, `debt`, `domestic product`, `unemployment`.

**WEO does not mark which values are projections.** Every WEO observation has an empty `status`, and series run several years past the current year. Report values for the current year onward as IMF projections, not outcomes. For the latest reported figure, query the topic dataflow (`CPI` monthly, `QNEA` quarterly, `ER`).

**WEO is annual and tied to one edition.** Its `FREQUENCY` dimension publishes only `A`, so a `Q` or `M` key returns `no_data`. `WEO` holds the latest edition. Values change between editions, recent historical years included. Earlier editions are separate dataflows named `WEO_<YYYY>_<MON>_VINTAGE` (for example `WEO_2026_APR_VINTAGE`). `imf_list_databases` shows them only with `include_vintages` true, and they take the same key as `WEO`. Name the edition when you cite a projection, and compare forecast revisions only across named editions.

**A `*` country position returns groups beside economies.** `*.NGDP_RPCH.A` on WEO returns World, G7, Euro Area, Advanced Economies, and regional groups in the same result as the countries. Drop them before ranking, averaging, or summing: exclude economy codes matching `^(G[0-9X]|U[0-9])`. A bare `^G` would also drop Ghana, Greece, and the United Kingdom (`GBR`). When the group itself is the question, query its code (`G119.NGDP_RPCH.A` for the G7).

**CPI group aggregates live in `CPI_WCA`.** `CPI` publishes economies plus the Euro Area, which it carries only under the `HICP` index type (`G163.HICP._T.YOY_PCH_PA_PT.M`; `G163.CPI…` returns `no_data`). World, Advanced Economies, G7, G20, emerging and developing, and continental CPI are in `CPI_WCA`, which uses the same key layout but publishes monthly (`M`) only. Other topics have the same kind of aggregate dataflow, titled "World and Country Aggregates" or "World and Country Group Aggregates": `QGDP_WCA`, `PI_WCA`, and `BOP_AGG`.

**A null `unit` doesn't mean the unit is unknown.** `CPI`, `ER`, `QNEA`, and `IL` series come back with `unit` null. The unit is spelled out in the key's codes: `YOY_PCH_PA_PT` is a percent change, `XDC_USD` is domestic currency per US dollar, `XDC` is domestic currency, and `USD` or `XDR` in the `IL` key is US dollars or SDRs. Report it from the code's name.

**Long exchange-rate histories can mix currency units.** `ER` restates some histories into today's currency and not others. `TUR.XDC_USD.PA_RT.A` reads 2.8 for 1950–1956 and 0.0000055 for 1958, and the 1957 value carries status `T`: a unit break, not a revaluation. A restated series looks different: `ARG` and `BRA` start near 10⁻⁸ and 10⁻¹¹ per US dollar in 1980 and climb year by year through their hyperinflations, all in today's currency. Before computing long-run depreciation, scan the series for a sudden drop like Turkey's and measure change only on one side of it; tiny early values alone are restatement, not a break.

**QNEA publishes levels, not growth rates.** Across the whole dataflow, `TYPE_OF_TRANSFORMATION` carries only `XDC`, `USD`, and `IX`. Compute growth from the seasonally adjusted constant-price series (`PRICE_TYPE` `Q`, `S_ADJUSTMENT` `SA`). Quarterly levels are not annualized: the four 2025 quarters for `USA` sum to roughly WEO's annual figure. A ratio of consecutive quarters is therefore a quarter-on-quarter rate, not an annualized one.

**Don't splice or mix series across dataflows.** `GDD` general government debt reaches back to 1950 for some economies. WEO gross debt starts later (1980 for `JPN`, 2001 for `USA`) and carries projections. The two disagree in overlapping years: the 2023 figure for `USA` differs by about a percentage point. Constant-price levels also use different bases: `DEU` real GDP for 2025 is about 3.1 trillion euros summed over `QNEA`'s quarters and 3.65 trillion in WEO. Take every value in a comparison from one dataflow, and state where the source changes if you must join two.

## Workflows

**Finding the dataflow.** Start here instead of searching the catalog for an indicator:

| Question | Dataflow | Key, verified |
|:--|:--|:--|
| Annual growth, inflation, debt, or unemployment across countries, with projections | `WEO` | `CAN+FRA+DEU+ITA+JPN+GBR+USA.NGDP_RPCH.A`; `G119.NGDP_RPCH.A` for the G7 aggregate |
| Monthly or quarterly consumer-price inflation | `CPI` | `BRA.CPI._T.YOY_PCH_PA_PT.M` (12-month inflation). `POP_PCH_PA_PT` is the change from the previous period, `IX` the index, and `SRP_` variants are rebased to 2010=100. `CPI` publishes `A`, `Q`, and `M` |
| CPI for World, G7, G20, or regions | `CPI_WCA` | same layout, with group codes in `COUNTRY` |
| Exchange rate against the US dollar | `ER` | `TUR.XDC_USD.PA_RT.M`. `PA_RT` is the period average and `EOP_RT` the end of period; `USD_XDC` is the inverse quote |
| Quarterly GDP | `QNEA` | `USA.B1GQ.Q.SA.XDC.Q` (levels only; see Gates) |
| Official reserves | `IL` | `JPN.TRGMV_REVS.USD.M` (total reserves, gold at market value). `UNIT` is `USD` or `XDR` |
| General government gross debt, % of GDP | `WEO` `GGXWDG_NGDP` | `FM` `G63G_S13_POGDP_PT` carries the same figures. For longer history, and for household, corporate, and private-sector debt, use `GDD` (`USA.FL_S13_POGDP_PT.A`); `HPD` is the Historical Public Debt dataflow |

For a topic not in the table, filter the catalog with an IMF topic word (`trade`, `balance of payments`), then search the `INDICATOR` codelist of each candidate.

**Comparing countries.** Put every economy in one `+` key and read `missing_series` before you compare. A series that ends early (`WBG` stops in 2025 while `KOS` runs into the projection years) means "latest" refers to different years.

**Large pulls and SQL.** Results too large to return inline are staged as a DataCanvas table, and the response carries a `canvas_id`. Call `imf_dataframe_describe` with it for the staged table and column names before writing SQL, then `imf_dataframe_query` with a read-only query. To stage another result beside the first, pass the same `canvas_id` with `output_mode` `canvas`. With `canvas_id` alone, a result small enough to return inline stays inline and the canvas is unchanged. The tables expire with the canvas. A staged table's columns include `series_key`, `time_period` (text), `value` (base units), `unit`, and `scale`. The economy code is the first segment of `series_key`, so this keeps economies only:

```sql
SELECT series_key, value FROM <table_name>
WHERE time_period = '2030' AND NOT regexp_matches(series_key, '^(G[0-9X]|U[0-9])')
ORDER BY value DESC LIMIT 5
```
