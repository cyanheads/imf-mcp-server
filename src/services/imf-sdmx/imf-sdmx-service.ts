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
  CodelistEntry,
  Dataflow,
  DataflowStructure,
  DataQueryResult,
  Dimension,
  Observation,
  SdmxDataResponse,
  SdmxStructureResponse,
  SeriesAttributes,
} from './types.js';

const DATAFLOWS_CACHE_TTL = 3600; // 1 hour
const DSD_CACHE_TTL = 86_400; // 24 hours

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

    const raw = await withRetry(
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
        const text = await response.text();
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

    // Derive DSD id from the dataflow — IMF SDMX 3.0 uses DSD_<FLOW_ID> naming for most flows.
    // We fetch the structure endpoint directly using the dataflow's agency+version.
    const dsdId = `DSD_${dataflowId}`;

    const structure = await this.fetchDataStructure(
      dataflow.agencyId,
      dsdId,
      dataflow.version,
      ctx,
    ).catch(async () => {
      // Fallback: some flows use the flow agency/version as the DSD path directly.
      // Fetch using the raw dataflow endpoint with ?references=all.
      return this.fetchDataflowStructureFallback(
        dataflowId,
        dataflow.agencyId,
        dataflow.version,
        ctx,
      );
    });

    if (!structure) {
      throw serviceUnavailable(`Structure unavailable for dataflow '${dataflowId}'`, {
        reason: 'structure_unavailable',
        dataflowId,
      });
    }

    // Merge name/description from the dataflow into the structure.
    const mergedDescription = structure.description ?? dataflow.description;
    return {
      ...structure,
      dataflowId,
      name: structure.name || dataflow.name,
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
    const qs = queryParams.toString() ? `?${queryParams.toString()}` : '';

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

    const dsd = dsds[0];
    if (!dsd) return;

    const dimList = dsd.dataStructureComponents?.dimensionList?.dimensions ?? [];

    // IMF SDMX 3.0 uses `position` (SDMX 3.0 spec); legacy used `keyPosition`.
    const sorted = [...dimList].sort(
      (a, b) => (a.position ?? a.keyPosition ?? 0) - (b.position ?? b.keyPosition ?? 0),
    );

    // Derive the dataflow ID portion for IMF naming-convention codelist lookup.
    // IMF SDMX 3.0 does not populate localRepresentation.enumeration — codelists are
    // identified by naming convention: CL_<FLOW_ID>_<DIM_ID> (flow-specific) or
    // CL_<DIM_ID> (shared). Try flow-specific first, then shared.
    const flowIdForCl = id.replace(/^DSD_/, '');

    const dimensions: Dimension[] = sorted.map((d, idx) => {
      const dimId = d.id ?? `DIM_${idx}`;
      const enumRef = d.localRepresentation?.enumeration;
      let codelist: CodelistEntry[] = [];

      // 1. IMF naming convention (primary path — enumeration is null on SDMX 3.0).
      // Also try the concept ID extracted from the conceptIdentity URN (e.g. FREQ from
      // "urn:sdmx:...CS_MASTER_SYSTEM(1.0).FREQ") since some shared codelists use the
      // concept ID rather than the dimension ID (e.g. FREQUENCY dim → CL_FREQ codelist).
      const conceptId =
        typeof d.conceptIdentity === 'string' ? d.conceptIdentity.replace(/^.*\./, '') : undefined;
      const conventionKeys = [
        `CL_${flowIdForCl}_${dimId}`,
        `CL_${dimId}`,
        ...(conceptId && conceptId !== dimId
          ? [`CL_${flowIdForCl}_${conceptId}`, `CL_${conceptId}`]
          : []),
      ];
      for (const k of conventionKeys) {
        const found = clMap.get(k);
        if (found && found.length > 0) {
          codelist = found;
          break;
        }
      }

      // 2. Explicit enumeration reference (fallback for servers that populate it)
      if (codelist.length === 0 && enumRef) {
        const enumKeys = [
          `${enumRef.agencyID ?? ''}:${enumRef.id ?? ''}:${enumRef.version ?? ''}`,
          `${enumRef.agencyID ?? ''}:${enumRef.id ?? ''}`,
          enumRef.id ?? '',
        ];
        for (const k of enumKeys) {
          const found = clMap.get(k);
          if (found && found.length > 0) {
            codelist = found;
            break;
          }
        }
      }

      return {
        id: dimId,
        name: dimId,
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
