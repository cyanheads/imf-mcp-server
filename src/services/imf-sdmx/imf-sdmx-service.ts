/**
 * @fileoverview IMF SDMX 3.0 REST API service — fetches dataflows, data structures,
 * and observations from api.imf.org. Implements caching via ctx.state and retry.
 * @module services/imf-sdmx/imf-sdmx-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import type { RequestContext } from '@cyanheads/mcp-ts-core/utils';
import { fetchWithTimeout, withRetry } from '@cyanheads/mcp-ts-core/utils';
import type {
  AvailabilityResult,
  CodelistEntry,
  Dataflow,
  DataflowStructure,
  DataQueryResult,
  Dimension,
  Observation,
  SdmxConcept,
  SdmxDataResponse,
  SdmxStructureResponse,
  SeriesAttributes,
} from './types.js';

const DATAFLOWS_CACHE_TTL = 3600; // 1 hour
const DSD_CACHE_TTL = 86_400; // 24 hours

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
          const response = await fetchWithTimeout(
            url,
            this.timeoutMs,
            ctx as unknown as RequestContext,
            {
              headers: { Accept: 'application/json' },
              signal: ctx.signal,
            },
          );
          const text = await response.text();
          return this.parseJson<SdmxStructureResponse>(text, 'dataflow list');
        },
        {
          operation: 'ImfSdmxService.fetchDataflows',
          context: ctx as unknown as RequestContext,
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

  /** Find a dataflow by id, optionally constraining by agencyId/version. */
  async findDataflow(
    dataflowId: string,
    agencyId: string | undefined,
    version: string | undefined,
    ctx: Context,
  ): Promise<Dataflow | undefined> {
    const all = await this.fetchDataflows(ctx);
    return all.find(
      (df) =>
        df.id === dataflowId &&
        (agencyId == null || df.agencyId === agencyId) &&
        (version == null || df.version === version),
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
        const response = await fetchWithTimeout(
          url,
          this.timeoutMs,
          ctx as unknown as RequestContext,
          {
            headers: { Accept: 'application/json' },
            signal: ctx.signal,
          },
        );
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
        context: ctx as unknown as RequestContext,
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

    const fallback = () =>
      this.fetchDataflowStructureFallback(dataflowId, dataflow.agencyId, dataflow.version, ctx);

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
      throw serviceUnavailable(`Structure unavailable for dataflow '${dataflowId}'`, {
        reason: 'structure_unavailable',
        dataflowId,
      });
    }

    if (!structure) {
      throw serviceUnavailable(`Structure unavailable for dataflow '${dataflowId}'`, {
        reason: 'structure_unavailable',
        dataflowId,
      });
    }

    // Pin identity to the dataflow's OWN values — a shared DSD (IIP → DSD_BOP)
    // must not overwrite the flow's public name/version/agency. Dimensions and
    // key_format legitimately flow from the (possibly shared) DSD. The DSD's own
    // version/id are surfaced additively as dsdVersion/dsdId for callers.
    const mergedDescription = structure.description ?? dataflow.description;
    return {
      ...structure,
      dataflowId,
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
        const response = await fetchWithTimeout(
          url,
          this.timeoutMs,
          ctx as unknown as RequestContext,
          {
            headers: { Accept: 'application/json' },
            signal: ctx.signal,
          },
        );
        const text = await response.text();
        return this.parseJson<SdmxStructureResponse>(text, 'dataflow structure (fallback)');
      },
      {
        operation: 'ImfSdmxService.fetchDataflowStructureFallback',
        context: ctx as unknown as RequestContext,
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

  /** Fetch observations for a dataflow key over a time range. No cache — always live. */
  async fetchData(
    agencyId: string,
    dataflowId: string,
    version: string,
    key: string,
    startPeriod?: string,
    endPeriod?: string,
    ctx?: Context,
    signal?: AbortSignal,
  ): Promise<DataQueryResult> {
    const queryParams = new URLSearchParams();
    if (startPeriod) queryParams.set('startPeriod', startPeriod);
    if (endPeriod) queryParams.set('endPeriod', endPeriod);
    const qsStr = queryParams.toString();
    const qs = qsStr ? `?${qsStr}` : '';

    // Build a minimal RequestContextLike for fetchWithTimeout when no ctx provided
    const now = new Date().toISOString();
    const fetchCtx: RequestContext = ctx
      ? (ctx as unknown as RequestContext)
      : ({ requestId: 'internal', timestamp: now } as RequestContext);

    const effectiveSignal = signal ?? ctx?.signal;
    const raw = await withRetry(
      async () => {
        const url = `${this.baseUrl}/data/dataflow/${encodeURIComponent(agencyId)}/${encodeURIComponent(dataflowId)}/${encodeURIComponent(version)}/${encodeURIComponent(key)}${qs}`;
        if (ctx) ctx.log.debug('Fetching data', { url });
        const response = await fetchWithTimeout(url, this.timeoutMs, fetchCtx, {
          headers: { Accept: 'application/json' },
          ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        });
        const text = await response.text();
        return this.parseJson<SdmxDataResponse>(text, 'data query');
      },
      {
        operation: 'ImfSdmxService.fetchData',
        context: ctx as unknown as RequestContext,
        maxRetries: 3,
        baseDelayMs: 1000,
        ...(effectiveSignal ? { signal: effectiveSignal } : {}),
      },
    );

    return this.decodeObservations(raw, dataflowId, key, startPeriod, endPeriod);
  }

  // ---------------------------------------------------------------------------
  // Availability constraint (SDMX 2.1 — used for no_data enrichment)
  // ---------------------------------------------------------------------------

  /**
   * Query the SDMX 2.1 availableconstraint endpoint for a dataflow + first-dimension code.
   * Returns parsed availability info (series_count, per-dimension codes, time range).
   * The 2.1 endpoint path is derived from the configured 3.0 base URL.
   *
   * Never throws — returns null on any failure so callers can degrade gracefully.
   */
  async fetchAvailabilityConstraint(
    dataflowId: string,
    firstDimensionCode: string,
    ctx?: Context,
    signal?: AbortSignal,
  ): Promise<AvailabilityResult | null> {
    // Derive the SDMX 2.1 base URL from the configured 3.0 URL.
    // e.g. https://api.imf.org/external/sdmx/3.0 → https://api.imf.org/external/sdmx/2.1
    const base21 = this.baseUrl.replace(/\/sdmx\/3\.0\/?$/, '/sdmx/2.1');
    const key = firstDimensionCode ? `${encodeURIComponent(firstDimensionCode)}..` : '';
    const url = `${base21}/availableconstraint/${encodeURIComponent(dataflowId)}/${key}`;

    const fetchCtx: RequestContext = ctx
      ? (ctx as unknown as RequestContext)
      : ({ requestId: 'avail', timestamp: new Date().toISOString() } as RequestContext);
    const effectiveSignal = signal ?? ctx?.signal;

    try {
      const response = await fetchWithTimeout(
        url,
        Math.min(this.timeoutMs, 10_000), // cap availability lookup at 10s
        fetchCtx,
        {
          headers: { Accept: 'application/xml, text/xml' },
          ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        },
      );

      if (!response.ok) return null;

      const xml = await response.text();
      return this.parseAvailabilityXml(xml);
    } catch {
      return null;
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
    const available_codes: Record<string, string[]> = {};
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
        // Cap per-dimension value lists to avoid bloating the error message
        available_codes[dimId] = values.slice(0, 20);
      }
    }

    return { series_count, available_codes, time_period_start, time_period_end };
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

    // Get name from dataflow if available
    const df = dataflows[0];
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
  ): DataQueryResult {
    const dataset = raw.data?.dataSets?.[0];
    const structure = raw.data?.structures?.[0];

    // Observation dimension (TIME_PERIOD)
    const obsDims = structure?.dimensions?.observation ?? [];
    const timeDim = obsDims[0];
    const timeValues = timeDim?.values ?? [];

    // Series attributes (UNIT, SCALE, DECIMALS, etc.)
    const seriesAttrs = structure?.attributes?.series ?? [];
    const obsAttrs = structure?.attributes?.observation ?? [];

    // Find STATUS attribute index in observation attributes
    const statusObsIdx = obsAttrs.findIndex((a) => a.id === 'STATUS');

    // Find attribute indices in series attributes
    const unitIdx = seriesAttrs.findIndex((a) => a.id === 'UNIT');
    const scaleIdx = seriesAttrs.findIndex((a) => a.id === 'SCALE');
    const decimalsIdx = seriesAttrs.findIndex((a) => a.id === 'DECIMALS_DISPLAYED');

    const series = dataset?.series ?? {};
    const observations: Observation[] = [];
    let seriesAttributes: SeriesAttributes = { unit: null, scale: null, decimals: null };

    // Series-level dimensions for decoding the colon-separated series key ("0:0:0").
    const seriesDims = structure?.dimensions?.series ?? [];

    for (const [seriesKey, seriesData] of Object.entries(series)) {
      // Decode the series key ("0:1:0") into dimension code values ("USA.NGDP_RPCH.A").
      const seriesKeyParts = seriesKey.split(':');
      const seriesCodeParts = seriesDims.map((dim, dimIdx) => {
        const valIdx = parseInt(seriesKeyParts[dimIdx] ?? '0', 10);
        const val = dim.values[valIdx];
        return val?.id ?? val?.value ?? seriesKeyParts[dimIdx] ?? '';
      });
      const decodedSeriesKey = seriesCodeParts.join('.');

      // Extract series-level attributes for the first series we find
      if (seriesData.attributes) {
        const attrs = seriesData.attributes;
        seriesAttributes = {
          unit: this.resolveAttrValue(unitIdx, attrs, seriesAttrs),
          scale: this.resolveAttrValue(scaleIdx, attrs, seriesAttrs),
          decimals: this.resolveDecimalsValue(decimalsIdx, attrs),
        };
      }

      // Decode observations
      for (const [obsIdx, obsValues] of Object.entries(seriesData.observations ?? {})) {
        const timeIdx = parseInt(obsIdx, 10);
        // IMF SDMX 3.0 uses `value` field for time periods; fallback to `id` for legacy compat.
        const timePeriod = timeValues[timeIdx]?.value ?? timeValues[timeIdx]?.id ?? obsIdx;
        const rawValue = obsValues?.[0];
        const value = rawValue != null && rawValue !== '' ? parseFloat(rawValue) : null;

        let status: string | null = null;
        if (statusObsIdx >= 0 && obsValues && obsValues[statusObsIdx + 1] != null) {
          const statusCode = obsValues[statusObsIdx + 1];
          const statusAttr = obsAttrs[statusObsIdx];
          if (statusCode != null && statusAttr?.values) {
            const idx2 = parseInt(statusCode, 10);
            status = statusAttr.values[idx2]?.id ?? statusCode;
          }
        }

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
      seriesAttributes,
    };
  }

  private resolveAttrValue(
    attrIdx: number,
    attrValues: Array<string | null>,
    attrDefs: Array<{ id: string; values?: Array<{ id: string; name?: string }> }>,
  ): string | null {
    if (attrIdx < 0 || attrIdx >= attrValues.length) return null;
    const raw = attrValues[attrIdx];
    if (raw == null) return null;
    const def = attrDefs[attrIdx];
    if (def?.values) {
      const idx = parseInt(raw, 10);
      if (!Number.isNaN(idx)) return def.values[idx]?.name ?? def.values[idx]?.id ?? raw;
    }
    return raw;
  }

  private resolveDecimalsValue(attrIdx: number, attrValues: Array<string | null>): number | null {
    if (attrIdx < 0 || attrIdx >= attrValues.length) return null;
    const raw = attrValues[attrIdx];
    if (raw == null) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
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
