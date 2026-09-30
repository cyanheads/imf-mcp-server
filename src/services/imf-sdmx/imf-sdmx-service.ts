/**
 * @fileoverview IMF SDMX 3.0 REST API service — fetches dataflows, data structures,
 * and observations from api.imf.org. Implements caching via ctx.state and retry.
 * A flow's own name, version, agency, and description survive a shared DSD;
 * series attributes are decoded per series and keyed by series key, so a
 * multi-series key does not collapse to one record, and unit / scale / decimals
 * are located across every id the portal spells them with rather than one each
 * and in both places the portal attaches them — a series' own attribute row and
 * the dimension group its declared relationship names, which is where most of
 * the catalog puts UNIT. A group the portal ships empty because the key
 * combines codes with `+` on a dimension that group is declared against is
 * recovered by one attributes-only request for the same series under a wildcard
 * key, which is the shape that makes the portal emit the group values;
 * the SDMX 2.1 availability constraint is parsed for no-data enrichment, listing
 * a dimension's codes up to AVAILABILITY_CODE_CAP alongside the pre-cap total.
 * @module services/imf-sdmx/imf-sdmx-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  AvailabilityDimension,
  AvailabilityResult,
  CodelistEntry,
  Dataflow,
  DataflowAvailabilityResult,
  DataflowRef,
  DataflowStructure,
  DataQueryResult,
  Dimension,
  Observation,
  SdmxAttributeDef,
  SdmxConcept,
  SdmxDataResponse,
  SdmxStructure,
  SdmxStructureResponse,
  SeriesAttributes,
} from './types.js';

const DATAFLOWS_CACHE_TTL = 3600; // 1 hour
const DSD_CACHE_TTL = 86_400; // 24 hours
const DATAFLOW_AVAILABILITY_CACHE_TTL = 3600; // 1 hour

/**
 * Most codes a dimension may list in an availability constraint — a message-size
 * bound, since WEO's COUNTRY carries 210 codes with data and INDICATOR 145.
 * `count` always carries the pre-cap total so the formatter can say how many of
 * how many it is showing; an unannotated slice is what let a caller read its own
 * valid code as uncovered.
 */
const AVAILABILITY_CODE_CAP = 20;

/**
 * Client-facing text for a failed dataflow-list fetch. Deliberately says nothing
 * about the upstream URL or its response body: `IMF_BASE_URL` is configurable, so
 * the resolved endpoint can name a private mirror or proxy, and the framework's
 * raw fetch error carries both (message → origin + path, `data.body` → up to 500
 * bytes of the upstream response). Wording avoids "not found" so callers that
 * branch on that substring don't misclassify an availability failure.
 */
const DATAFLOW_LIST_UNAVAILABLE_MESSAGE =
  'IMF dataflow catalog is unavailable — the upstream SDMX structure endpoint did not return a usable response.';
const DATAFLOW_LIST_RECOVERY_HINT =
  'Retry in a few moments. The IMF SDMX 3.0 portal is intermittently unavailable; if it keeps failing the upstream service is down.';

/**
 * The series-attribute ids that carry unit, scale, and precision, per decoded
 * attribute and in precedence order.
 *
 * The portal does not name these attributes uniformly. A sweep of every
 * dataflow's DSD attribute list (222 dataflows over 214 distinct structures)
 * found exactly seven series-attached spellings across the three concepts: the
 * IMF-authored structures use `UNIT` / `SCALE` / `DECIMALS_DISPLAYED`, while
 * three externally-authored or one-off structures name the same facts with the
 * SDMX-standard ids or a variant — `NA_MAIN` (ESTAT) uses `UNIT_MULT` and
 * `DECIMALS`, `SDG` (IAEG-SDGs) uses `UNIT_MEASURE`, and `PCPS` uses the
 * singular `DECIMAL_DISPLAYED`. Matching one id per attribute reported `null`
 * for every series on those flows even though the payload carried the values.
 *
 * `PRECISION` and the observation-attached `UNIT_MULT` are deliberately absent:
 * both attach to the observation, not the series, so they never appear in the
 * series attribute list this index is taken against.
 *
 * Order is the tie-break, IMF-specific spelling first. No dataflow in the
 * catalog declares two spellings of one concept, so the tie-break does not fire
 * today; it exists so one that later does resolves the same way on every
 * request rather than by whichever id the payload happens to list first.
 */
const SERIES_ATTRIBUTE_ALIASES = {
  unit: ['UNIT', 'UNIT_MEASURE'],
  scale: ['SCALE', 'UNIT_MULT'],
  decimals: ['DECIMALS_DISPLAYED', 'DECIMALS', 'DECIMAL_DISPLAYED'],
} as const satisfies Record<keyof SeriesAttributes, readonly string[]>;

/**
 * Position of the first alias present in a payload's series attribute
 * definitions, or -1 when the payload declares none of them. The position is
 * what indexes a series' own positional `attributes` array, so it must come
 * from the payload's own ordering rather than from the alias list.
 */
function findSeriesAttrIndex(defs: Array<{ id: string }>, aliases: readonly string[]): number {
  for (const alias of aliases) {
    const idx = defs.findIndex((def) => def.id === alias);
    if (idx >= 0) return idx;
  }
  return -1;
}

/**
 * Stands in for an attribute row the payload does not carry. `resolveAttrValue`
 * reports null for any index outside the row it is given, so an absent series
 * row and a group lookup that found nothing both resolve without a branch.
 */
const NO_ATTRIBUTE_ROW: Array<string | number | null> = [];

/**
 * Slot positions of the dimensions an attribute is declared against, ordered as
 * a dimension-group key lists them: the series dimensions, then the observation
 * dimension. `UNIT` on `WEO` is declared against `["INDICATOR"]` and so answers
 * `[1]` — the slot its group keys constrain.
 *
 * The positions are sorted because a relationship lists its dimensions in no
 * particular order — `QGDP_WCA` declares one against
 * `["TYPE_OF_TRANSFORMATION", "INDICATOR"]`, the reverse of the key order —
 * while a group key is read left to right.
 *
 * Returns undefined when the attribute is absent or declares no relationship.
 * Nothing then says which group's row describes a given series, and a guess is a
 * wrong unit rather than a missing one. A relationship naming a dimension the
 * payload does not list resolves to a position no group key can constrain, so it
 * finds no row either.
 */
function dimensionGroupSlots(
  def: SdmxAttributeDef | undefined,
  dimensionOrder: string[],
): number[] | undefined {
  const dims = def?.relationship?.dimensions;
  if (!dims || dims.length === 0) return;
  return dims.map((id) => dimensionOrder.indexOf(id)).sort((a, b) => a - b);
}

/**
 * Index `dataSets[0].dimensionGroupAttributes` so an attribute can be handed the
 * row of the one group its own declared relationship names.
 *
 * A group key carries one colon-separated slot per declared dimension, in the
 * order the series dimensions are listed with the observation dimension last.
 * The slots the group constrains hold an index into that dimension's `values`;
 * the rest are empty and match anything, so `":0::"` on WEO pins INDICATOR to
 * its first code and leaves COUNTRY, FREQUENCY, and TIME_PERIOD open. Matching a
 * series therefore means comparing the slots of the attribute's relationship
 * against the same positions of the series' own key.
 *
 * Keys are bucketed by which slots they constrain, so the lookup for one
 * attribute reads only the bucket its relationship selects. One structure can
 * declare attributes over several different dimension subsets — `FAS` files them
 * under COUNTRY, under INDICATOR, and under TYPE_OF_TRANSFORMATION — and each is
 * then answered from its own bucket, never from a row filed under a subset that
 * describes a different set of series. Bucketing also keeps the per-series cost
 * proportional to the number of concepts read rather than to the number of
 * groups, which reaches 552 on `FSIBSIS` against its 43,848 series.
 *
 * Returns undefined when the payload carries no groups, so the common case adds
 * no per-series work at all.
 */
function buildDimensionGroupLookup(
  groupAttributes: Record<string, Array<string | number | null>> | undefined,
):
  | ((slots: number[], seriesKeyParts: string[]) => Array<string | number | null> | undefined)
  | undefined {
  const entries = Object.entries(groupAttributes ?? {});
  if (entries.length === 0) return;

  const buckets = new Map<string, Map<string, Array<string | number | null>>>();
  for (const [groupKey, values] of entries) {
    const slots = groupKey.split(':');
    const constrained: number[] = [];
    for (const [index, slot] of slots.entries()) {
      if (slot !== '') constrained.push(index);
    }
    const bucketId = constrained.join(',');
    let rows = buckets.get(bucketId);
    if (!rows) {
      rows = new Map();
      buckets.set(bucketId, rows);
    }
    rows.set(constrained.map((index) => slots[index]).join(':'), values);
  }

  return (slots, seriesKeyParts) =>
    // A slot past the series key belongs to the observation dimension, which a
    // series key says nothing about; projecting it as empty makes the lookup
    // miss rather than pair a series with a group it is not in.
    buckets.get(slots.join(','))?.get(slots.map((index) => seriesKeyParts[index] ?? '').join(':'));
}

/**
 * Query string that strips a data response down to the attributes it carries.
 *
 * `measures=none` drops every observation value and `attributes=series` drops
 * the observation-attached attribute rows, leaving the structure block, one
 * bare row per series, and `dataSets[0].dimensionGroupAttributes` — which is
 * the only part the group probe reads. Both are SDMX 3.0 REST parameters the
 * portal honours; an unrecognized parameter is ignored rather than rejected, so
 * the reduction was confirmed against the payload rather than assumed.
 *
 * The pair is what bounds the probe. `measures=none` alone still returns an
 * observation row per period wherever a dataflow carries observation
 * attributes, which on `PPI` is 85 KB against the 4 KB this returns.
 */
const ATTRIBUTES_ONLY_QUERY = 'attributes=series&measures=none';

/** Longest a group probe may take before it is abandoned and the query answers without it. */
const GROUP_PROBE_TIMEOUT_MS = 10_000;

/**
 * One dimension-group attribute recovered from a probe response, addressed the
 * way both responses agree on.
 *
 * A group key indexes each dimension's `values` list, and the portal does not
 * hold that list in a stable order between two differently-shaped requests for
 * the same series — `PPI` returns TYPE_OF_TRANSFORMATION as `["IX",
 * "POP_PCH_PT"]` for one key and the reverse for the other. Carrying the codes
 * rather than the indices is what keeps the recovered value on the series it
 * describes.
 */
interface GroupAttributeOverlay {
  /** Resolved value, keyed by the codes those dimensions take, joined by ':'. */
  byCodes: Map<string, string>;
  /** Ids of the dimensions the attribute is declared against, in key order. */
  dimensions: string[];
}

/** Recovered group attributes, per concept. Absent concepts were not recovered. */
type DimensionGroupOverlay = Partial<Record<keyof SeriesAttributes, GroupAttributeOverlay>>;

/** Every decoded concept, typed so a lookup over the alias table stays exhaustive. */
const SERIES_ATTRIBUTE_CONCEPTS = Object.keys(SERIES_ATTRIBUTE_ALIASES) as Array<
  keyof SeriesAttributes
>;

/** Digit count from an already-resolved attribute value, or null when it is not a number. */
function toDecimals(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Concepts the payload declares a dimension group for and then ships nothing in.
 *
 * A group attribute's cell is an index into its definition's `values`, so a
 * definition with no `values` cannot resolve for any series no matter which
 * group row matches. That is the shape the portal returns when a key combines
 * codes with `+` on the very dimension the group is declared against and no
 * position uses `*`: `WEO`'s `USA.NGDP_RPCH+NGDPD.A` ships the definitions
 * empty and omits `dimensionGroupAttributes` altogether, while `PPI`'s
 * `USA.PPI.POP_PCH_PT+IX.A` ships the block with the rows of other groups and
 * the same empty definition. Both reduce to one statement — declared,
 * unresolvable — so neither payload shape is matched on.
 *
 * It is a necessary condition and not a sufficient one. A dataflow that
 * declares a unit and genuinely publishes none (`CPI`, `LS`, and a long tail —
 * around a hundred of them) presents identically here, and no request of any
 * shape recovers a value for it. `plusOnGroupDimension` is what tells the two
 * apart.
 *
 * A definition without a relationship is skipped: nothing then says which slots
 * of a group key describe it, so a differently-shaped request cannot help.
 */
function suppressedGroupConcepts(
  structure: SdmxStructure | undefined,
): Array<keyof SeriesAttributes> {
  const defs = structure?.attributes?.dimensionGroup ?? [];
  if (defs.length === 0) return [];
  return SERIES_ATTRIBUTE_CONCEPTS.filter((concept) => {
    const def = defs[findSeriesAttrIndex(defs, SERIES_ATTRIBUTE_ALIASES[concept])];
    if (!def?.relationship?.dimensions?.length) return false;
    return (def.values?.length ?? 0) === 0;
  });
}

/** Ids of every dimension the given suppressed groups are declared against. */
function suppressedGroupDimensions(
  structure: SdmxStructure | undefined,
  concepts: Array<keyof SeriesAttributes>,
): Set<string> {
  const defs = structure?.attributes?.dimensionGroup ?? [];
  return new Set(
    concepts.flatMap(
      (concept) =>
        defs[findSeriesAttrIndex(defs, SERIES_ATTRIBUTE_ALIASES[concept])]?.relationship
          ?.dimensions ?? [],
    ),
  );
}

/**
 * Whether the key combines codes with `+` at a position the suppressed group is
 * declared against — the one key shape that makes the portal ship a group it
 * would otherwise populate.
 *
 * This is what keeps the probe off ordinary traffic. An empty group alone does
 * not distinguish a suppressed response from the ~100 dataflows that declare a
 * unit and publish none, whose every response carries the same empty group: a
 * literal single-code key on each flow that declares one fired a probe on 35 of
 * the 65 that returned series and recovered a value on none, since their `*`
 * form ships the group empty too.
 *
 * Requiring the `+` drops no recovery, because it is the portal's own trigger.
 * Across 30 dataflows that do populate the group, a `+` on any dimension the
 * group is *not* declared against left the values intact (`WEO`'s
 * `USA+GBR.NGDP_RPCH.A` resolves normally), and a `+` on one it *is* declared
 * against emptied them every time — down to a degenerate `NGDPD+NGDPD`.
 *
 * A key whose segment count disagrees with the payload's own series dimensions
 * cannot be positioned against them, and `widenedProbeKey` could not build a
 * probe key for it either.
 */
function plusOnGroupDimension(
  key: string,
  structure: SdmxStructure | undefined,
  concepts: Array<keyof SeriesAttributes>,
): boolean {
  const segments = key.split('.');
  const seriesDims = structure?.dimensions?.series ?? [];
  if (segments.length !== seriesDims.length) return false;

  const groupDimensions = suppressedGroupDimensions(structure, concepts);
  return segments.some(
    (segment, index) => segment.includes('+') && groupDimensions.has(seriesDims[index]?.id ?? ''),
  );
}

/**
 * The key to probe with: the original with one position widened to `*`.
 *
 * Any `*` in the key is enough to make the portal emit the group values, so the
 * choice of position is purely a cost question — and an expensive one. Widening
 * is measured against the live portal at 6.5 KB for `WEO`'s FREQUENCY, 80 KB
 * for its INDICATOR, and 220 KB for its COUNTRY; on `GFS_BS`, COUNTRY reaches
 * 2 MB over 17 seconds. So the position is the one whose codelist is smallest —
 * the frequency dimension for two thirds of the catalogue's flows and a narrow
 * indicator or transformation dimension for the rest. Across every flow that
 * declares a dimension-group unit, the chosen codelist holds at most 34 codes,
 * which is what keeps the probe a few kilobytes rather than a few hundred.
 *
 * Dimensions the suppressed groups are declared against are excluded, since
 * widening one of those multiplies the group rows themselves rather than just
 * the series. Returns undefined when no other position has a resolved codelist
 * to size — the query then answers exactly as it does without the probe.
 */
function widenedProbeKey(
  key: string,
  dimensions: Dimension[],
  structure: SdmxStructure | undefined,
  concepts: Array<keyof SeriesAttributes>,
): string | undefined {
  const segments = key.split('.');
  if (segments.length !== dimensions.length) return;

  const groupDimensions = suppressedGroupDimensions(structure, concepts);

  let position = -1;
  let smallest = Number.POSITIVE_INFINITY;
  for (const [index, dimension] of dimensions.entries()) {
    if (groupDimensions.has(dimension.id)) continue;
    const size = dimension.codelist.length;
    if (size === 0 || size >= smallest) continue;
    smallest = size;
    position = index;
  }
  if (position < 0) return;

  return segments.map((segment, index) => (index === position ? '*' : segment)).join('.');
}

/** An SDMX artefact reference: the agency / id / version triple a URN encodes. */
interface ArtefactRef {
  agencyId: string;
  id: string;
  version: string;
}

/** Every SDMX URN ends `<Class>=AGENCY:ID(VERSION)`. */
const ARTEFACT_URN = /([A-Za-z]+)=([^:]+):([^(]+)\(([^)]+)\)/;

/**
 * Parse an SDMX artefact URN of the given class into its agency / id / version
 * parts. One parser covers the DataStructure references on dataflows and the
 * Codelist references on dimensions and concepts; a URN of a different class
 * does not parse.
 *
 * @example
 * parseArtefactUrn('urn:sdmx:...DataStructure=IMF.STA:DSD_BOP(24.0+.0)', 'DataStructure')
 * // → { agencyId: 'IMF.STA', id: 'DSD_BOP', version: '24.0.0' }
 */
function parseArtefactUrn(urn: string, artefact: string): ArtefactRef | undefined {
  const match = ARTEFACT_URN.exec(urn);
  if (!match) return;
  const [, artefactClass, agencyId, id, rawVersion] = match;
  if (artefactClass !== artefact || !agencyId || !id || !rawVersion) return;
  // IMF encodes versions with a wildcard marker (e.g. "24.0+.0"); strip the "+"
  // to get the concrete version the structure endpoints resolve.
  return { agencyId, id, version: rawVersion.replace(/\+/g, '') };
}

/**
 * Parse a Concept URN, which appends the concept id to the scheme reference:
 * `Concept=AGENCY:SCHEME(VERSION).CONCEPT_ID`.
 *
 * @example
 * parseConceptUrn('urn:sdmx:...Concept=IMF.RES:CS_CTOT(4.0+.0).WGT_TYPE')
 * // → { agencyId: 'IMF.RES', schemeId: 'CS_CTOT', conceptId: 'WGT_TYPE' }
 */
function parseConceptUrn(
  urn: string,
): { agencyId: string; schemeId: string; conceptId: string } | undefined {
  const match = /Concept=([^:]+):([^(]+)\(([^)]+)\)\.(.+)$/.exec(urn);
  if (!match) return;
  const [, agencyId, schemeId, , conceptId] = match;
  if (!agencyId || !schemeId || !conceptId) return;
  return { agencyId, schemeId, conceptId };
}

export class ImfSdmxService {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(_config: AppConfig, _storage: StorageService, baseUrl: string, timeoutMs: number) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
  }

  // ---------------------------------------------------------------------------
  // Dataflow list
  // ---------------------------------------------------------------------------

  /** Fetch all dataflows, with 1-hour caching. */
  async fetchDataflows(ctx: Context): Promise<Dataflow[]> {
    const cacheKey = 'imf/dataflows/all';
    const cached = await ctx.state.get<Dataflow[]>(cacheKey);
    if (cached) {
      ctx.log.debug('Dataflows served from cache', { count: cached.length });
      return cached;
    }

    /**
     * Error boundary around the whole retry pipeline. Every entry point on this
     * server reaches the dataflow list (directly or via findDataflow), so an
     * unguarded failure here leaks the resolved upstream URL — and, on the
     * resource path, the upstream response body — into the client error.
     * Mirrors the boundary fetchDataflowStructure() already applies to the DSD path.
     */
    let raw: SdmxStructureResponse;
    try {
      raw = await withRetry(
        async () => {
          const url = `${this.baseUrl}/structure/dataflow`;
          ctx.log.debug('Fetching dataflow list', { url });
          const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
            headers: { Accept: 'application/json' },
            signal: ctx.signal,
          });
          const text = await response.text();
          return this.parseJson<SdmxStructureResponse>(text, 'dataflow list');
        },
        {
          operation: 'ImfSdmxService.fetchDataflows',
          context: ctx,
          maxRetries: 3,
          baseDelayMs: 1000,
          signal: ctx.signal,
        },
      );
    } catch (err: unknown) {
      // Upstream detail stays server-side; only the controlled message goes out.
      ctx.log.error(
        'Dataflow list fetch failed',
        err instanceof Error ? err : new Error(String(err)),
      );
      throw serviceUnavailable(DATAFLOW_LIST_UNAVAILABLE_MESSAGE, {
        reason: 'dataflow_list_unavailable',
        recovery: { hint: DATAFLOW_LIST_RECOVERY_HINT },
      });
    }

    const dataflows = this.normalizeDataflows(raw);
    await ctx.state.set(cacheKey, dataflows, { ttl: DATAFLOWS_CACHE_TTL });
    ctx.log.info('Dataflows fetched and cached', { count: dataflows.length });
    return dataflows;
  }

  /**
   * Find a dataflow by id, optionally constraining by agencyId/version. The id is
   * trimmed and matched case-insensitively (the portal itself is case-sensitive),
   * with an exact spelling preferred; callers use the returned `id` downstream.
   */
  async findDataflow(
    dataflowId: string,
    agencyId: string | undefined,
    version: string | undefined,
    ctx: Context,
  ): Promise<Dataflow | undefined> {
    const all = await this.fetchDataflows(ctx);
    const wanted = dataflowId.trim();
    const inScope = all.filter(
      (df) =>
        (agencyId == null || df.agencyId === agencyId) &&
        (version == null || df.version === version),
    );
    return (
      inScope.find((df) => df.id === wanted) ??
      inScope.find((df) => df.id.toLowerCase() === wanted.toLowerCase())
    );
  }

  // ---------------------------------------------------------------------------
  // Data structure (DSD + codelists)
  // ---------------------------------------------------------------------------

  /** Fetch DSD with all codelists for a dataflow, with 24-hour caching. */
  async fetchDataStructure(
    agencyId: string,
    dsdId: string,
    version: string,
    ctx: Context,
  ): Promise<DataflowStructure | undefined> {
    const cacheKey = `imf/dsd/${agencyId}/${dsdId}/${version}`;
    const cached = await ctx.state.get<DataflowStructure>(cacheKey);
    if (cached) {
      ctx.log.debug('DSD served from cache', { dsdId });
      return cached;
    }

    const raw = await withRetry(
      async () => {
        const url = `${this.baseUrl}/structure/datastructure/${encodeURIComponent(agencyId)}/${encodeURIComponent(dsdId)}/${encodeURIComponent(version)}?references=all`;
        ctx.log.debug('Fetching data structure', { url });
        const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
          headers: { Accept: 'application/json' },
          signal: ctx.signal,
        });
        // HTTP 204 (or an empty body) means the DSD id does not exist — a
        // definitive miss, not a transient error. Opt out of retry (retryable:
        // false) so callers fall through to the fallback immediately rather than
        // exhausting the retry budget against a guaranteed-empty response.
        const text = await response.text();
        if (response.status === 204 || text.trim() === '') {
          throw notFound(`Data structure '${dsdId}' not found`, {
            reason: 'dsd_not_found',
            retryable: false,
          });
        }
        return this.parseJson<SdmxStructureResponse>(text, 'data structure');
      },
      {
        operation: 'ImfSdmxService.fetchDataStructure',
        context: ctx,
        maxRetries: 3,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    const structure = this.normalizeDsd(raw, agencyId, dsdId, version);
    if (!structure) return;

    await ctx.state.set(cacheKey, structure, { ttl: DSD_CACHE_TTL });
    return structure;
  }

  /**
   * Fetch a dataflow's structure, resolving the DSD reference from the dataflow
   * list if not provided.
   */
  async fetchDataflowStructure(
    dataflowId: string,
    agencyId: string | undefined,
    version: string | undefined,
    ctx: Context,
  ): Promise<DataflowStructure> {
    const dataflow = await this.findDataflow(dataflowId, agencyId, version, ctx);
    if (!dataflow) {
      throw notFound(`Dataflow '${dataflowId}' not found`, {
        reason: 'dataflow_not_found',
        dataflowId,
      });
    }

    // Resolve the DSD from the dataflow's own `structure` URN. IMF names DSDs
    // independently of the flow (ER → DSD_ER_PUB, IIP → shared DSD_BOP), so the
    // legacy `DSD_<flow>` guess returns HTTP 204 for those and burns the retry
    // budget before falling through. The fallback (dataflow endpoint with
    // references=all) covers flows whose URN is absent or unparseable.
    const dsdRef = dataflow.structure
      ? parseArtefactUrn(dataflow.structure, 'DataStructure')
      : undefined;

    // The catalog spelling, not the argument — findDataflow matched it case-insensitively.
    const { id } = dataflow;
    const fallback = () =>
      this.fetchDataflowStructureFallback(id, dataflow.agencyId, dataflow.version, ctx);

    let structure: DataflowStructure | undefined;
    try {
      structure = dsdRef
        ? await this.fetchDataStructure(dsdRef.agencyId, dsdRef.id, dsdRef.version, ctx).catch(
            fallback,
          )
        : await fallback();
    } catch {
      // Both primary and fallback DSD fetch failed; throw a controlled message
      // (the raw McpError would carry the upstream URL path in its message).
      throw serviceUnavailable(`Structure unavailable for dataflow '${id}'`, {
        reason: 'structure_unavailable',
        dataflowId: id,
      });
    }

    if (!structure) {
      throw serviceUnavailable(`Structure unavailable for dataflow '${id}'`, {
        reason: 'structure_unavailable',
        dataflowId: id,
      });
    }

    // Pin identity to the dataflow's OWN values — a shared DSD (IIP → DSD_BOP)
    // must not overwrite the flow's public name/version/agency/description.
    // Dimensions and key_format legitimately flow from the (possibly shared)
    // DSD. The DSD's own version/id are surfaced additively as dsdVersion/dsdId.
    // Description falls back to the structure's only when the flow carries none,
    // so imf_get_database reports what imf_list_databases reports for the same id.
    const mergedDescription = dataflow.description ?? structure.description;
    return {
      ...structure,
      dataflowId: id,
      agencyId: dataflow.agencyId,
      version: dataflow.version,
      name: dataflow.name,
      dsdVersion: structure.version,
      ...(mergedDescription ? { description: mergedDescription } : {}),
    };
  }

  /** Fallback: fetch structure using the dataflow endpoint path directly. */
  private async fetchDataflowStructureFallback(
    dataflowId: string,
    agencyId: string,
    version: string,
    ctx: Context,
  ): Promise<DataflowStructure | undefined> {
    const cacheKey = `imf/dsd-fb/${agencyId}/${dataflowId}/${version}`;
    const cached = await ctx.state.get<DataflowStructure>(cacheKey);
    if (cached) return cached;

    const raw = await withRetry(
      async () => {
        const url = `${this.baseUrl}/structure/dataflow/${encodeURIComponent(agencyId)}/${encodeURIComponent(dataflowId)}/${encodeURIComponent(version)}?references=all`;
        ctx.log.debug('Fetching dataflow structure (fallback)', { url });
        const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
          headers: { Accept: 'application/json' },
          signal: ctx.signal,
        });
        const text = await response.text();
        return this.parseJson<SdmxStructureResponse>(text, 'dataflow structure (fallback)');
      },
      {
        operation: 'ImfSdmxService.fetchDataflowStructureFallback',
        context: ctx,
        maxRetries: 3,
        baseDelayMs: 1000,
        signal: ctx.signal,
      },
    );

    const structure = this.normalizeDsd(raw, agencyId, dataflowId, version);
    if (structure) {
      await ctx.state.set(cacheKey, structure, { ttl: DSD_CACHE_TTL });
    }
    return structure;
  }

  // ---------------------------------------------------------------------------
  // Data query
  // ---------------------------------------------------------------------------

  /**
   * Fetch observations for a dataflow key over a time range. No cache — always live.
   * `lastNObservations` asks the portal for each series' last N cells, null
   * padding included; it rides the data request only, never the group probe.
   */
  async fetchData(
    agencyId: string,
    dataflowId: string,
    version: string,
    key: string,
    startPeriod: string | undefined,
    endPeriod: string | undefined,
    ctx: Context,
    signal?: AbortSignal,
    lastNObservations?: number,
  ): Promise<DataQueryResult> {
    const queryParams = new URLSearchParams();
    if (startPeriod) queryParams.set('startPeriod', startPeriod);
    if (endPeriod) queryParams.set('endPeriod', endPeriod);
    if (lastNObservations !== undefined) {
      queryParams.set('lastNObservations', String(lastNObservations));
    }
    const qsStr = queryParams.toString();
    const qs = qsStr ? `?${qsStr}` : '';

    const effectiveSignal = signal ?? ctx.signal;
    const raw = await withRetry(
      async () => {
        const url = `${this.baseUrl}/data/dataflow/${encodeURIComponent(agencyId)}/${encodeURIComponent(dataflowId)}/${encodeURIComponent(version)}/${encodeURIComponent(key)}${qs}`;
        ctx.log.debug('Fetching data', { url });
        const response = await fetchWithTimeout(url, this.timeoutMs, ctx, {
          headers: { Accept: 'application/json' },
          signal: effectiveSignal,
        });
        const text = await response.text();
        return this.parseJson<SdmxDataResponse>(text, 'data query');
      },
      {
        operation: 'ImfSdmxService.fetchData',
        context: ctx,
        maxRetries: 3,
        baseDelayMs: 1000,
        signal: effectiveSignal,
      },
    );

    const overlay = await this.fetchGroupAttributeOverlay(
      raw,
      agencyId,
      dataflowId,
      version,
      key,
      ctx,
      effectiveSignal,
    );

    return this.decodeObservations(raw, dataflowId, key, startPeriod, endPeriod, overlay);
  }

  /**
   * Recover dimension-group attributes the portal declared and shipped empty,
   * by asking for the same series under a key with one position widened to `*`.
   *
   * The response cannot be repaired after the fact — the values are simply not
   * in it — so the only recovery is a differently-shaped request. This one is
   * shaped to carry the attributes and nothing else: a single GET, no retry,
   * its own short timeout, `ATTRIBUTES_ONLY_QUERY` so no observation comes
   * back, and the cheapest position to widen (see `widenedProbeKey`). Measured
   * live, it adds ~6.5 KB and ~0.25 s on `WEO` and ~4 KB on `PPI`, to queries
   * that would otherwise report no unit at all.
   *
   * Every exit is the query answering as it does today. A probe that fails,
   * times out, is aborted, or comes back with nothing returns undefined, and
   * the concepts stay `null` — it is an addition to the success path, so it may
   * never turn one into a failure.
   *
   * It fires only for the shape it can fix. A key that already carries a `*` is
   * already the shape the probe would build, so its response is as complete as
   * the portal will make it; a payload with no series has nothing to annotate;
   * a payload whose groups carry values needs no help; and a key with no `+` on
   * a dimension the empty group is declared against was never suppressed, so
   * there is nothing in a second response for it to gain
   * (`plusOnGroupDimension`). Together those keep every ordinary query — any
   * key the portal answered completely, on any dataflow — at exactly one
   * upstream request.
   */
  private async fetchGroupAttributeOverlay(
    raw: SdmxDataResponse,
    agencyId: string,
    dataflowId: string,
    version: string,
    key: string,
    ctx: Context,
    signal?: AbortSignal,
  ): Promise<DimensionGroupOverlay | undefined> {
    if (key.includes('*')) return;

    const dataStructure = raw.data?.structures?.[0];
    const concepts = suppressedGroupConcepts(dataStructure);
    if (concepts.length === 0) return;
    if (!plusOnGroupDimension(key, dataStructure, concepts)) return;
    // Last, because it is the only guard that walks the payload: a wide + key
    // resolves to thousands of series, and the cheap tests above have already
    // rejected every response shape but the one this can repair.
    if (Object.keys(raw.data?.dataSets?.[0]?.series ?? {}).length === 0) return;

    try {
      const structure = await this.fetchDataflowStructure(dataflowId, agencyId, version, ctx);
      const probeKey = widenedProbeKey(key, structure.dimensions, dataStructure, concepts);
      if (!probeKey) return;

      const url = `${this.baseUrl}/data/dataflow/${encodeURIComponent(agencyId)}/${encodeURIComponent(dataflowId)}/${encodeURIComponent(version)}/${encodeURIComponent(probeKey)}?${ATTRIBUTES_ONLY_QUERY}`;
      ctx.log.debug('Probing for suppressed dimension-group attributes', {
        url,
        concepts,
      });
      const response = await fetchWithTimeout(
        url,
        Math.min(this.timeoutMs, GROUP_PROBE_TIMEOUT_MS),
        ctx,
        {
          headers: { Accept: 'application/json' },
          ...(signal ? { signal } : {}),
        },
      );
      const probe = this.parseJson<SdmxDataResponse>(
        await response.text(),
        'dimension-group probe',
      );
      return this.buildGroupOverlay(probe, concepts);
    } catch (err: unknown) {
      ctx.log.debug('Dimension-group probe returned nothing usable', {
        dataflowId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  /**
   * Index a probe response's group rows by the codes they describe, per concept.
   *
   * The rows are read exactly as the main decode reads its own: a row belongs to
   * a concept only when the slots it constrains are the slots that concept's
   * relationship names, so a structure filing several attributes over different
   * dimension subsets cannot hand one of them another subset's row. What
   * differs is the address — each row's constrained slots are resolved to their
   * dimension codes here, because the two responses index their `values` lists
   * independently.
   *
   * A relationship naming the observation dimension, or one the probe's own
   * series dimensions do not carry, is dropped: a series key says nothing about
   * those, so no series could be shown to be in the group.
   */
  private buildGroupOverlay(
    raw: SdmxDataResponse,
    concepts: Array<keyof SeriesAttributes>,
  ): DimensionGroupOverlay | undefined {
    const structure = raw.data?.structures?.[0];
    const defs = structure?.attributes?.dimensionGroup ?? [];
    const rows = Object.entries(raw.data?.dataSets?.[0]?.dimensionGroupAttributes ?? {});
    if (defs.length === 0 || rows.length === 0) return;

    const seriesDims = structure?.dimensions?.series ?? [];
    const slotOrder = [...seriesDims, ...(structure?.dimensions?.observation ?? [])].map(
      (dim) => dim.id,
    );

    const overlay: DimensionGroupOverlay = {};
    for (const concept of concepts) {
      const attrIdx = findSeriesAttrIndex(defs, SERIES_ATTRIBUTE_ALIASES[concept]);
      const slots = dimensionGroupSlots(defs[attrIdx], slotOrder);
      if (!slots || slots.some((slot) => slot < 0 || slot >= seriesDims.length)) continue;

      const byCodes = new Map<string, string>();
      for (const [groupKey, row] of rows) {
        const parts = groupKey.split(':');
        const constrained = parts.flatMap((part, index) => (part === '' ? [] : [index]));
        if (constrained.length !== slots.length) continue;
        if (constrained.some((slot, index) => slot !== slots[index])) continue;

        const value = this.resolveAttrValue(attrIdx, row, defs);
        if (value == null) continue;

        const codes = slots.map((slot) => {
          const dimension = seriesDims[slot];
          const valueIdx = Number.parseInt(parts[slot] ?? '', 10);
          const code = dimension?.values[valueIdx];
          return code?.id ?? code?.value ?? parts[slot] ?? '';
        });
        byCodes.set(codes.join(':'), value);
      }

      if (byCodes.size > 0) {
        overlay[concept] = {
          dimensions: slots.map((slot) => seriesDims[slot]?.id ?? ''),
          byCodes,
        };
      }
    }

    return Object.keys(overlay).length > 0 ? overlay : undefined;
  }

  // ---------------------------------------------------------------------------
  // Availability constraint (SDMX 2.1 — used for no_data enrichment)
  // ---------------------------------------------------------------------------

  /**
   * SDMX 2.1 availableconstraint URL for one dataflow, with the 2.1 base derived
   * from the configured 3.0 one (`…/sdmx/3.0` → `…/sdmx/2.1`). The flow is named
   * by its full `agency,id,version` reference, the identity the data request
   * already uses: the portal resolves a bare id as `all:<id>(latest)`, and for a
   * flow such as IMF.SPR's GPT that answers 404 rather than a constraint. `key` is
   * the path segment after the flow — empty for the dataflow-wide form.
   */
  private availabilityUrl(dataflow: DataflowRef, key: string): string {
    const base21 = this.baseUrl.replace(/\/sdmx\/3\.0\/?$/, '/sdmx/2.1');
    const flowRef = [dataflow.agencyId, dataflow.id, dataflow.version]
      .map((part) => encodeURIComponent(part))
      .join(',');
    return `${base21}/availableconstraint/${flowRef}/${key}`;
  }

  /**
   * Query the SDMX 2.1 availableconstraint endpoint for a dataflow + first-dimension code.
   * Returns parsed availability info (series_count, per-dimension codes, time range).
   *
   * Pass an empty `firstDimensionCode` for the dataflow-wide constraint. That form
   * is the only one that separates a dataflow publishing nothing from a single
   * uncovered code: a key-scoped constraint reports `series_count: 0` and an empty
   * cube region for both, while the unscoped one reports the dataflow's own total
   * and the codes that do have data.
   *
   * Never throws — returns null on any failure so callers can degrade gracefully.
   */
  async fetchAvailabilityConstraint(
    dataflow: DataflowRef,
    firstDimensionCode: string,
    ctx: Context,
    signal?: AbortSignal,
  ): Promise<AvailabilityResult | null> {
    const url = this.availabilityUrl(
      dataflow,
      firstDimensionCode ? `${encodeURIComponent(firstDimensionCode)}..` : '',
    );

    const effectiveSignal = signal ?? ctx.signal;

    try {
      const response = await fetchWithTimeout(
        url,
        Math.min(this.timeoutMs, 10_000), // cap availability lookup at 10s
        ctx,
        {
          headers: { Accept: 'application/xml, text/xml' },
          signal: effectiveSignal,
        },
      );

      // fetchWithTimeout throws on any non-2xx, so a returned response is always ok.
      const xml = await response.text();
      return this.parseAvailabilityXml(xml);
    } catch {
      return null;
    }
  }

  /**
   * Fetch the uncapped dataflow-wide availability constraint with tenant-scoped
   * caching. Unlike fetchAvailabilityConstraint(), this is a positive discovery
   * surface: it preserves every code and fails explicitly when coverage cannot
   * be established rather than degrading to a codelist response.
   */
  async fetchDataflowAvailability(
    dataflow: DataflowRef,
    ctx: Context,
    signal?: AbortSignal,
  ): Promise<DataflowAvailabilityResult> {
    const { agencyId, id: dataflowId, version } = dataflow;
    const cacheKey = `imf/availability/dataflow/${agencyId}/${dataflowId}/${version}`;
    const cached = await ctx.state.get<DataflowAvailabilityResult>(cacheKey);
    if (cached) {
      ctx.log.debug('Dataflow availability served from cache', { agencyId, dataflowId, version });
      return cached;
    }

    const url = this.availabilityUrl(dataflow, '');
    const effectiveSignal = signal ?? ctx.signal;

    try {
      const response = await fetchWithTimeout(url, Math.min(this.timeoutMs, 10_000), ctx, {
        headers: { Accept: 'application/xml, text/xml' },
        signal: effectiveSignal,
      });

      const availability = this.parseDataflowAvailabilityXml(await response.text());
      if (!availability) throw new Error('Availability response was not a usable SDMX constraint');

      await ctx.state.set(cacheKey, availability, { ttl: DATAFLOW_AVAILABILITY_CACHE_TTL });
      return availability;
    } catch (err: unknown) {
      ctx.log.error(
        'Dataflow availability fetch failed',
        err instanceof Error ? err : new Error(String(err)),
        { agencyId, dataflowId, version },
      );
      throw serviceUnavailable(
        `Availability coverage is unavailable for dataflow '${dataflowId}'`,
        {
          reason: 'availability_unavailable',
          retryable: true,
          recovery: {
            hint: 'Retry in a few moments; the IMF availability endpoint did not return usable coverage.',
          },
        },
      );
    }
  }

  /**
   * Parse the SDMX 2.1 availableconstraint XML response.
   * Extracts series_count annotation, cube-region com:KeyValue entries, and time annotations.
   */
  private parseAvailabilityXml(xml: string): AvailabilityResult | null {
    // series_count annotation: <com:AnnotationTitle>N</com:AnnotationTitle> following id="series_count"
    const seriesCountMatch =
      /id="series_count"[^>]*>[\s\S]*?<com:AnnotationTitle>(\d+)<\/com:AnnotationTitle>/i.exec(xml);
    const series_count = seriesCountMatch ? parseInt(seriesCountMatch[1] ?? '0', 10) : 0;

    // time_period_start / time_period_end annotations
    const tpsMatch =
      /id="time_period_start"[^>]*>[\s\S]*?<com:AnnotationTitle>([^<]+)<\/com:AnnotationTitle>/i.exec(
        xml,
      );
    const tpeMatch =
      /id="time_period_end"[^>]*>[\s\S]*?<com:AnnotationTitle>([^<]+)<\/com:AnnotationTitle>/i.exec(
        xml,
      );
    const time_period_start = tpsMatch?.[1]?.trim() ?? null;
    const time_period_end = tpeMatch?.[1]?.trim() ?? null;

    // Cube region KeyValues: <com:KeyValue id="DIMENSION"> <com:Value>CODE</com:Value> ... </com:KeyValue>
    const available_codes: Record<string, AvailabilityDimension> = {};
    for (const kvMatch of xml.matchAll(
      /<com:KeyValue\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/com:KeyValue>/gi,
    )) {
      const dimId = kvMatch[1] ?? '';
      const inner = kvMatch[2] ?? '';
      if (!dimId) continue;

      const values = [...inner.matchAll(/<com:Value>([^<]+)<\/com:Value>/gi)]
        .map((m) => m[1]?.trim() ?? '')
        .filter(Boolean);

      if (values.length > 0) {
        // count is pre-cap; codes may be a prefix of it — see AvailabilityDimension.
        available_codes[dimId] = {
          count: values.length,
          codes: values.slice(0, AVAILABILITY_CODE_CAP),
        };
      }
    }

    return { series_count, available_codes, time_period_start, time_period_end };
  }

  /** Parse an uncapped dataflow-wide availability constraint for discovery. */
  private parseDataflowAvailabilityXml(xml: string): DataflowAvailabilityResult | null {
    const seriesCountMatch =
      /id="series_count"[^>]*>[\s\S]*?<com:AnnotationTitle>(\d+)<\/com:AnnotationTitle>/i.exec(xml);
    if (!seriesCountMatch) return null;
    const series_count = Number.parseInt(seriesCountMatch[1] ?? '0', 10);

    const tpsMatch =
      /id="time_period_start"[^>]*>[\s\S]*?<com:AnnotationTitle>([^<]+)<\/com:AnnotationTitle>/i.exec(
        xml,
      );
    const tpeMatch =
      /id="time_period_end"[^>]*>[\s\S]*?<com:AnnotationTitle>([^<]+)<\/com:AnnotationTitle>/i.exec(
        xml,
      );

    const availableCodes = new Map<string, Set<string>>();
    for (const kvMatch of xml.matchAll(
      /<com:KeyValue\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/com:KeyValue>/gi,
    )) {
      const dimensionId = kvMatch[1] ?? '';
      if (!dimensionId) continue;
      const values = availableCodes.get(dimensionId) ?? new Set<string>();
      for (const match of (kvMatch[2] ?? '').matchAll(/<com:Value>([^<]+)<\/com:Value>/gi)) {
        const value = match[1]?.trim();
        if (value) values.add(value);
      }
      availableCodes.set(dimensionId, values);
    }

    if (series_count > 0 && ![...availableCodes.values()].some((values) => values.size > 0)) {
      return null;
    }

    const available_codes = Object.fromEntries(
      [...availableCodes].map(([dimensionId, values]) => [dimensionId, [...values]]),
    );

    return {
      series_count,
      available_codes,
      time_period_start: tpsMatch?.[1]?.trim() ?? null,
      time_period_end: tpeMatch?.[1]?.trim() ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Normalizers
  // ---------------------------------------------------------------------------

  private normalizeDataflows(raw: SdmxStructureResponse): Dataflow[] {
    const flows = raw.data?.dataflows ?? [];
    return flows.map((f) => ({
      id: f.id,
      agencyId: f.agencyID ?? 'IMF',
      version: f.version ?? '1.0',
      name: f.names?.en ?? f.id,
      ...(f.descriptions?.en ? { description: f.descriptions.en } : {}),
      ...(f.structure ? { structure: f.structure } : {}),
    }));
  }

  private normalizeDsd(
    raw: SdmxStructureResponse,
    agencyId: string,
    id: string,
    version: string,
  ): DataflowStructure | undefined {
    const dsds = raw.data?.dataStructures ?? [];
    const codelists = raw.data?.codelists ?? [];
    const dataflows = raw.data?.dataflows ?? [];

    // Build a codelist map: id → entries
    const clMap = new Map<string, CodelistEntry[]>();
    for (const cl of codelists) {
      const entries: CodelistEntry[] = (cl.codes ?? []).map((c) => ({
        id: c.id,
        name: c.names?.en ?? c.id,
      }));
      clMap.set(cl.id, entries);
      if (cl.agencyID) {
        clMap.set(`${cl.agencyID}:${cl.id}`, entries);
        clMap.set(`${cl.agencyID}:${cl.id}:${cl.version ?? '1.0'}`, entries);
      }
    }

    /**
     * Build a concept map so each dimension can reach its concept, which carries
     * the human-readable label and — on IMF-authored DSDs — the authoritative
     * codelist reference. A dimension's `conceptIdentity` URN cites the scheme
     * with a wildcard version (`CS_NEA(2.0+.0)`) while the shipped scheme is
     * concrete (`2.0.0`), so version is not a usable key component.
     */
    const conceptMap = new Map<string, SdmxConcept>();
    for (const cs of raw.data?.conceptSchemes ?? []) {
      for (const concept of cs.concepts ?? []) {
        if (cs.agencyID) conceptMap.set(`${cs.agencyID}:${cs.id}.${concept.id}`, concept);
        conceptMap.set(`${cs.id}.${concept.id}`, concept);
      }
    }

    /** Resolve a Codelist URN against the shipped codelists, widening the key on each miss. */
    const codelistFromUrn = (urn: string | undefined): CodelistEntry[] | undefined => {
      if (!urn) return;
      const ref = parseArtefactUrn(urn, 'Codelist');
      if (!ref) return;
      // The URN's version routinely trails the shipped codelist's patch
      // (CL_CTOT_INDICATOR cited at 2.0.0, shipped at 2.0.1), so an exact-version
      // miss is normal — fall back to the agency-qualified id, then the bare id.
      for (const key of [
        `${ref.agencyId}:${ref.id}:${ref.version}`,
        `${ref.agencyId}:${ref.id}`,
        ref.id,
      ]) {
        const found = clMap.get(key);
        if (found && found.length > 0) return found;
      }
      return;
    };

    const dsd = dsds[0];
    if (!dsd) return;

    const dimList = dsd.dataStructureComponents?.dimensionList?.dimensions ?? [];

    // IMF SDMX 3.0 uses `position` (SDMX 3.0 spec); legacy used `keyPosition`.
    const sorted = [...dimList].sort(
      (a, b) => (a.position ?? a.keyPosition ?? 0) - (b.position ?? b.keyPosition ?? 0),
    );

    /**
     * Flow token for the IMF naming-convention fallback. It comes from the DSD's
     * OWN id, not the queried dataflow id — IIP shares DSD_BOP, whose codelists
     * are CL_BOP_*, and ER → DSD_ER_PUB carries a publication suffix. The
     * convention is CL_<FLOW>_<DIM> / CL_<FLOW>_<DIM>_PUB (flow-specific) then
     * CL_<DIM> / CL_<DIM>_PUB (shared), with the flow token tried both with the
     * suffix (DSD_ER_PUB → ER_PUB) and stripped (→ ER).
     */
    const resolvedDsdId = dsd.id ?? id;
    const flowCore = resolvedDsdId.replace(/^DSD_/, '');
    const flowBase = flowCore.replace(/_PUB$/i, '');
    const flowTokens = [...new Set([flowCore, flowBase])];

    const dimensions: Dimension[] = sorted.map((d, idx) => {
      const dimId = d.id ?? `DIM_${idx}`;

      // The dimension's concept carries its label and, on IMF-authored DSDs, the
      // only machine-readable codelist reference.
      const conceptRef =
        typeof d.conceptIdentity === 'string' ? parseConceptUrn(d.conceptIdentity) : undefined;
      const concept = conceptRef
        ? (conceptMap.get(
            `${conceptRef.agencyId}:${conceptRef.schemeId}.${conceptRef.conceptId}`,
          ) ?? conceptMap.get(`${conceptRef.schemeId}.${conceptRef.conceptId}`))
        : undefined;

      /**
       * Codelist resolution, authoritative references first:
       * 1. The dimension's own `localRepresentation.enumeration` URN — present on
       *    the ESTAT- and IAEG-SDGs-authored structures (NA_MAIN, SDG).
       * 2. The concept's `coreRepresentation.enumeration` URN — the reference on
       *    IMF-authored structures, which omit `localRepresentation` entirely.
       *    This resolves the dimensions whose codelist the naming convention
       *    cannot name: QNEA's CL_NEA_* (flow token differs from the DSD id),
       *    DIP/IMTS's COUNTERPART_COUNTRY (reuses the primary CL_*_COUNTRY), and
       *    LS's CL_LS_TYPE_OF_TRANSFORMAtION (upstream casing typo, cited verbatim).
       * 3. The IMF naming convention — for dimensions neither URN resolves.
       */
      let codelist =
        codelistFromUrn(d.localRepresentation?.enumeration) ??
        codelistFromUrn(concept?.coreRepresentation?.enumeration) ??
        [];

      if (codelist.length === 0) {
        // Some shared codelists key off the concept rather than the dimension id
        // (FREQUENCY dim → CL_FREQ codelist), so both tokens are tried.
        const nameTokens = [
          ...new Set([
            dimId,
            ...(conceptRef?.conceptId && conceptRef.conceptId !== dimId
              ? [conceptRef.conceptId]
              : []),
          ]),
        ];
        const conventionKeys: string[] = [];
        for (const ft of flowTokens) {
          for (const nt of nameTokens) {
            conventionKeys.push(`CL_${ft}_${nt}`, `CL_${ft}_${nt}_PUB`);
          }
        }
        for (const nt of nameTokens) {
          conventionKeys.push(`CL_${nt}`, `CL_${nt}_PUB`);
        }
        for (const k of conventionKeys) {
          const found = clMap.get(k);
          if (found && found.length > 0) {
            codelist = found;
            break;
          }
        }
      }

      return {
        id: dimId,
        name: concept?.names?.en ?? dimId,
        position: d.position ?? d.keyPosition ?? idx,
        codelist,
      };
    });

    // Build key format string from sorted dimension ids
    const keyFormat = dimensions.map((d) => d.id).join('.');

    /**
     * Fall back to the dataflow entry only when it is the one being normalized.
     * A `?references=all` DSD payload lists every flow sharing the structure, in
     * an order the portal does not hold stable (DSD_GFS lists its six flows, and
     * which comes first varies between requests), so `dataflows[0]` is an
     * arbitrary sibling — reading name or description off it hands the caller
     * another flow's identity. The match resolves on the fallback path, where
     * `id` is the dataflow id; on the DSD path `id` is the DSD's own id, which
     * no dataflow entry carries, so nothing matches and the DSD's own values
     * stand. Either way fetchDataflowStructure() pins the flow's identity on top.
     */
    const df = dataflows.find((f) => f.id === id);
    const name = dsd.names?.en ?? df?.names?.en ?? id;
    const description = dsd.descriptions?.en ?? df?.descriptions?.en;

    return {
      dataflowId: id,
      agencyId: dsd.agencyID ?? agencyId,
      version: dsd.version ?? version,
      dsdId: resolvedDsdId,
      name,
      ...(description ? { description } : {}),
      keyFormat,
      dimensions,
    };
  }

  private decodeObservations(
    raw: SdmxDataResponse,
    dataflowId: string,
    key: string,
    startPeriod?: string,
    endPeriod?: string,
    overlay?: DimensionGroupOverlay,
  ): DataQueryResult {
    const dataset = raw.data?.dataSets?.[0];
    const structure = raw.data?.structures?.[0];

    // Observation dimension (TIME_PERIOD)
    const obsDims = structure?.dimensions?.observation ?? [];
    const timeDim = obsDims[0];
    const timeValues = timeDim?.values ?? [];

    // Series attributes (UNIT, SCALE, DECIMALS_DISPLAYED, etc.)
    const seriesAttrs = structure?.attributes?.series ?? [];
    const obsAttrs = structure?.attributes?.observation ?? [];
    const groupAttrs = structure?.attributes?.dimensionGroup ?? [];

    // Find STATUS attribute index in observation attributes
    const statusObsIdx = obsAttrs.findIndex((a) => a.id === 'STATUS');
    const statusCodes = obsAttrs[statusObsIdx]?.values;

    // Find attribute indices in series attributes, across every id the portal
    // spells each attribute with (see SERIES_ATTRIBUTE_ALIASES).
    const unitIdx = findSeriesAttrIndex(seriesAttrs, SERIES_ATTRIBUTE_ALIASES.unit);
    const scaleIdx = findSeriesAttrIndex(seriesAttrs, SERIES_ATTRIBUTE_ALIASES.scale);
    const decimalsIdx = findSeriesAttrIndex(seriesAttrs, SERIES_ATTRIBUTE_ALIASES.decimals);

    // Series-level dimensions for decoding the colon-separated series key ("0:0:0").
    const seriesDims = structure?.dimensions?.series ?? [];

    /**
     * The same three concepts, located again in the dimensionGroup list, each
     * paired with the key slots its own relationship names. The two lists are
     * disjoint by construction — a DSD declares each attribute at one
     * relationship — so an id resolved here is one the series list does not carry.
     */
    const groupUnitIdx = findSeriesAttrIndex(groupAttrs, SERIES_ATTRIBUTE_ALIASES.unit);
    const groupScaleIdx = findSeriesAttrIndex(groupAttrs, SERIES_ATTRIBUTE_ALIASES.scale);
    const groupDecimalsIdx = findSeriesAttrIndex(groupAttrs, SERIES_ATTRIBUTE_ALIASES.decimals);
    const groupSlotOrder = [...seriesDims, ...obsDims].map((dim) => dim.id);
    const groupUnitSlots = dimensionGroupSlots(groupAttrs[groupUnitIdx], groupSlotOrder);
    const groupScaleSlots = dimensionGroupSlots(groupAttrs[groupScaleIdx], groupSlotOrder);
    const groupDecimalsSlots = dimensionGroupSlots(groupAttrs[groupDecimalsIdx], groupSlotOrder);
    const groupRowFor =
      groupUnitSlots || groupScaleSlots || groupDecimalsSlots
        ? buildDimensionGroupLookup(dataset?.dimensionGroupAttributes)
        : undefined;
    /** The row of the group covering this series, or an empty row when there is none. */
    const groupRowOf = (slots: number[] | undefined, keyParts: string[]) =>
      (slots && groupRowFor?.(slots, keyParts)) ?? NO_ATTRIBUTE_ROW;

    /**
     * The same group statement, recovered from a probe response when this one
     * declared the group and shipped it empty. Positioned against THIS payload's
     * series dimensions, since the overlay is addressed by dimension id and
     * code — the two responses order their `values` lists independently.
     */
    const overlayPositions = new Map<keyof SeriesAttributes, number[]>();
    if (overlay) {
      const seriesDimIds = seriesDims.map((dim) => dim.id);
      for (const concept of SERIES_ATTRIBUTE_CONCEPTS) {
        const entry = overlay[concept];
        if (!entry) continue;
        const positions = entry.dimensions.map((id) => seriesDimIds.indexOf(id));
        if (positions.some((position) => position < 0)) continue;
        overlayPositions.set(concept, positions);
      }
    }
    const overlayValueOf = (concept: keyof SeriesAttributes, codeParts: string[]) => {
      const positions = overlayPositions.get(concept);
      if (!positions) return null;
      return (
        overlay?.[concept]?.byCodes.get(
          positions.map((position) => codeParts[position] ?? '').join(':'),
        ) ?? null
      );
    };

    const series = dataset?.series ?? {};
    const observations: Observation[] = [];
    const seriesAttributesByKey: Record<string, SeriesAttributes> = {};
    /** The flat field describes the first series decoded only — see DataQueryResult. */
    let firstSeriesAttributes: SeriesAttributes | undefined;

    for (const [seriesKey, seriesData] of Object.entries(series)) {
      // Decode the series key ("0:1:0") into dimension code values ("USA.NGDP_RPCH.A").
      const seriesKeyParts = seriesKey.split(':');
      const seriesCodeParts = seriesDims.map((dim, dimIdx) => {
        const valIdx = parseInt(seriesKeyParts[dimIdx] ?? '0', 10);
        const val = dim.values[valIdx];
        return val?.id ?? val?.value ?? seriesKeyParts[dimIdx] ?? '';
      });
      const decodedSeriesKey = seriesCodeParts.join('.');

      /**
       * Attributes belong to the series that carries them. Assigning them to one
       * shared variable inside this loop let the last series decoded overwrite
       * every earlier one, so a `USA.NGDPD+NGDP_RPCH.A` query reported a single
       * scale for two series that do not share it.
       */
      const attrs = seriesData.attributes ?? NO_ATTRIBUTE_ROW;
      /**
       * The group a series falls in describes it as truly as its own attribute
       * row does — the two lists just partition the DSD's attributes by how many
       * of the key dimensions each one is declared against. Reading only the
       * series row is what reported `unit: null` across most of the catalog,
       * where `UNIT` is declared against the indicator alone.
       *
       * Each concept is read from the group its own relationship names, so a
       * structure filing several attributes over different dimension subsets
       * cannot hand one of them a row that describes a different set of series.
       *
       * The series row still wins any concept both lists somehow carry: a
       * relationship over the whole key describes one series, a group describes
       * a set of them, and the narrower statement is the one to keep. The
       * probe overlay is last of all: it is the same group statement this
       * payload should have carried, so it answers only where the payload
       * itself said nothing.
       */
      const decodedAttributes: SeriesAttributes = {
        unit:
          this.resolveAttrValue(unitIdx, attrs, seriesAttrs) ??
          this.resolveAttrValue(
            groupUnitIdx,
            groupRowOf(groupUnitSlots, seriesKeyParts),
            groupAttrs,
          ) ??
          overlayValueOf('unit', seriesCodeParts),
        scale:
          this.resolveAttrValue(scaleIdx, attrs, seriesAttrs) ??
          this.resolveAttrValue(
            groupScaleIdx,
            groupRowOf(groupScaleSlots, seriesKeyParts),
            groupAttrs,
          ) ??
          overlayValueOf('scale', seriesCodeParts),
        decimals:
          this.resolveDecimalsValue(decimalsIdx, attrs, seriesAttrs) ??
          this.resolveDecimalsValue(
            groupDecimalsIdx,
            groupRowOf(groupDecimalsSlots, seriesKeyParts),
            groupAttrs,
          ) ??
          toDecimals(overlayValueOf('decimals', seriesCodeParts)),
      };
      seriesAttributesByKey[decodedSeriesKey] = decodedAttributes;
      // First write wins. Counting the map's keys here instead made the decode
      // quadratic in series count — a `*` key on a wide dataflow resolves to
      // tens of thousands of series, and the count was recomputed for each one.
      firstSeriesAttributes ??= decodedAttributes;

      // Decode observations
      for (const [obsIdx, obsValues] of Object.entries(seriesData.observations ?? {})) {
        const timeIdx = parseInt(obsIdx, 10);
        // IMF SDMX 3.0 uses `value` field for time periods; fallback to `id` for legacy compat.
        const timePeriod = timeValues[timeIdx]?.value ?? timeValues[timeIdx]?.id ?? obsIdx;
        const rawValue = obsValues?.[0];
        const value = rawValue != null && rawValue !== '' ? parseFloat(String(rawValue)) : null;

        /**
         * STATUS resolves the way series attributes do: through the definition's
         * `values` when it has them, and as the literal the cell carries when it
         * does not. Every dataflow checked that declares STATUS ships it uncoded
         * (`[null, null, 0, "T"]`), so reading only the coded form reported
         * `null` for every flag. A coded cell arrives as a JSON number.
         */
        const statusCell = statusObsIdx >= 0 ? obsValues?.[statusObsIdx + 1] : undefined;
        const status =
          statusCell == null
            ? null
            : (statusCodes?.[Number.parseInt(String(statusCell), 10)]?.id ?? String(statusCell));

        observations.push({ series_key: decodedSeriesKey, time_period: timePeriod, value, status });
      }
    }

    // Sort observations by time_period
    observations.sort((a, b) => a.time_period.localeCompare(b.time_period));

    return {
      dataflowId,
      key,
      ...(startPeriod ? { startPeriod } : {}),
      ...(endPeriod ? { endPeriod } : {}),
      observations,
      seriesAttributes: firstSeriesAttributes ?? { unit: null, scale: null, decimals: null },
      seriesAttributesByKey,
    };
  }

  private resolveAttrValue(
    attrIdx: number,
    attrValues: Array<string | number | null>,
    attrDefs: Array<{ id: string; values?: Array<{ id: string; name?: string }> }>,
  ): string | null {
    if (attrIdx < 0 || attrIdx >= attrValues.length) return null;
    const raw = attrValues[attrIdx];
    if (raw == null) return null;
    // Coded cells arrive as JSON numbers, free-text ones as strings.
    const value = String(raw);
    const def = attrDefs[attrIdx];
    if (def?.values) {
      const idx = parseInt(value, 10);
      if (!Number.isNaN(idx)) return def.values[idx]?.name ?? def.values[idx]?.id ?? value;
    }
    return value;
  }

  /**
   * The precision attribute is coded like the rest: the series entry holds an
   * index into the attribute definition's `values`, not the digit count. Read
   * straight, WEO's `[0, 0, 0, …]` against `values: [{ id: "3" }]` reports 0
   * decimals for a series that displays 3. Resolving through the definition first
   * — and falling back to the literal when the attribute ships no `values` — is
   * what makes the number mean what it says.
   *
   * Both paths are reached in the catalog and both are alias-independent, since
   * the index is resolved before this runs: `DECIMALS_DISPLAYED` and NA_MAIN's
   * `DECIMALS` ship `values` and resolve through them, while PCPS's
   * `DECIMAL_DISPLAYED` ships none and falls back to its literal.
   */
  private resolveDecimalsValue(
    attrIdx: number,
    attrValues: Array<string | number | null>,
    attrDefs: Array<{ id: string; values?: Array<{ id: string; name?: string }> }>,
  ): number | null {
    return toDecimals(this.resolveAttrValue(attrIdx, attrValues, attrDefs));
  }

  private parseJson<T>(text: string, context: string): T {
    if (/^\s*<(!DOCTYPE\s+html|html[\s>])/i.test(text)) {
      throw serviceUnavailable(`IMF API returned HTML instead of JSON (${context})`);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw serviceUnavailable(`Failed to parse IMF API response as JSON (${context})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Init/accessor pattern
// ---------------------------------------------------------------------------

let _service: ImfSdmxService | undefined;

export function initImfSdmxService(
  config: AppConfig,
  storage: StorageService,
  baseUrl: string,
  timeoutMs: number,
): void {
  _service = new ImfSdmxService(config, storage, baseUrl, timeoutMs);
}

export function getImfSdmxService(): ImfSdmxService {
  if (!_service) {
    throw new Error('ImfSdmxService not initialized — call initImfSdmxService() in setup()');
  }
  return _service;
}
