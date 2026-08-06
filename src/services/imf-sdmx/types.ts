/**
 * @fileoverview Domain types for the IMF SDMX 3.0 service.
 * @module services/imf-sdmx/types
 */

/** A single dataflow entry from the IMF SDMX structure/dataflow endpoint. */
export interface Dataflow {
  agencyId: string;
  description?: string;
  id: string;
  name: string;
  /**
   * SDMX URN of the DSD this dataflow references, e.g.
   * `"urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_BOP(24.0+.0)"`.
   * IMF names DSDs independently of the flow (ER → DSD_ER_PUB, IIP → shared
   * DSD_BOP), so this is the authoritative structure reference.
   */
  structure?: string;
  version: string;
}

/** A single codelist entry: the machine code and human-readable name. */
export interface CodelistEntry {
  id: string;
  name: string;
}

/** A single dimension in a dataflow's data structure definition. */
export interface Dimension {
  codelist: CodelistEntry[];
  id: string;
  name: string;
  position: number;
}

/** Fully-described dataflow including all dimensions and their codelists. */
export interface DataflowStructure {
  agencyId: string;
  dataflowId: string;
  description?: string;
  dimensions: Dimension[];
  /**
   * Identifier of the underlying DSD, e.g. `"DSD_BOP"`. Differs from
   * `dataflowId` when the flow references a shared structure (IIP → DSD_BOP).
   */
  dsdId?: string;
  /**
   * Version of the underlying DSD. Differs from `version` (the dataflow's own
   * version) when the flow references a shared or independently-versioned DSD.
   */
  dsdVersion?: string;
  /** Dimension names in keyPosition order, e.g. "COUNTRY.INDICATOR.FREQUENCY" */
  keyFormat: string;
  name: string;
  version: string;
}

/** A decoded observation row. */
export interface Observation {
  /** Dot-separated dimension codes for this series, e.g. "USA.NGDP_RPCH.A". */
  series_key: string;
  status: string | null;
  time_period: string;
  value: number | null;
}

/** Attributes carried per-series (unit, scale, decimals). */
export interface SeriesAttributes {
  decimals: number | null;
  scale: string | null;
  unit: string | null;
}

/** Result of a data query, pre-spill. */
export interface DataQueryResult {
  dataflowId: string;
  endPeriod?: string;
  key: string;
  observations: Observation[];
  seriesAttributes: SeriesAttributes;
  startPeriod?: string;
}

/** Raw SDMX 3.0 JSON response shape (compact format). */
export interface SdmxDataResponse {
  data?: {
    dataSets?: Array<{
      series?: Record<string, SdmxSeries>;
    }>;
    structures?: Array<SdmxStructure>;
  };
}

export interface SdmxSeries {
  attributes?: Array<string | null>;
  observations?: Record<string, Array<string | null>>;
}

export interface SdmxStructure {
  attributes?: {
    series?: Array<SdmxAttributeDef>;
    observation?: Array<SdmxAttributeDef>;
  };
  dimensions?: {
    /** Series-level dimensions — values array lists the code for each index position in the series key. */
    series?: Array<SdmxDimensionDef>;
    observation?: Array<SdmxDimensionDef>;
  };
}

export interface SdmxDimensionDef {
  id: string;
  /** IMF SDMX 3.0 uses `value` for observation dimension values (e.g. time periods);
   *  legacy SDMX 2.1 used `id`. Both are optional to handle either format. */
  values: Array<{ id?: string; value?: string; name?: string }>;
}

export interface SdmxAttributeDef {
  id: string;
  values?: Array<{ id: string; name?: string }>;
}

/**
 * Coverage of a single dimension in an availability constraint.
 *
 * `count` is always the full number of codes the constraint reports; `codes` is
 * the leading slice of them that fits the listing cap. The two are separate
 * fields because the slice on its own reads as the whole set — a caller that
 * does not find its own valid code in an unannotated list concludes the code is
 * uncovered. `codes.length < count` is the signal that more exist; the two are
 * equal when the list is complete.
 */
export interface AvailabilityDimension {
  /** Codes with data, up to the listing cap — a prefix of the set when capped. */
  codes: string[];
  /** Number of codes with data, before any listing cap. */
  count: number;
}

/**
 * Parsed result from the SDMX 2.1 availableconstraint endpoint.
 * Used to enrich no_data errors with actual coverage information.
 */
export interface AvailabilityResult {
  /** Per-dimension coverage that actually has data (from cube region KeyValues). */
  available_codes: Record<string, AvailabilityDimension>;
  /** Total series count for the queried constraint. 0 = code not covered at all. */
  series_count: number;
  /** Latest period with data, if present in the constraint annotations. */
  time_period_end: string | null;
  /** Earliest period with data, if present in the constraint annotations. */
  time_period_start: string | null;
}

/** Raw SDMX structure response shape. */
export interface SdmxStructureResponse {
  data?: {
    dataflows?: Array<{
      id: string;
      agencyID?: string;
      version?: string;
      names?: Record<string, string>;
      descriptions?: Record<string, string>;
      /**
       * SDMX URN string referencing this dataflow's DSD, e.g.
       * `"urn:sdmx:...DataStructure=IMF.STA:DSD_ER_PUB(4.0+.0)"`. The live API
       * returns a string here, not an object.
       */
      structure?: string;
    }>;
    dataStructures?: Array<{
      id: string;
      agencyID?: string;
      version?: string;
      names?: Record<string, string>;
      descriptions?: Record<string, string>;
      dataStructureComponents?: {
        dimensionList?: {
          dimensions?: Array<{
            id?: string;
            /** String URN in IMF SDMX 3.0 (e.g. "urn:sdmx:...=IMF.RES:CS_WEO(4.0).COUNTRY"). */
            conceptIdentity?: string | { id?: string; urn?: string };
            /** SDMX 3.0 position — IMF returns this field instead of keyPosition. */
            position?: number;
            /** Legacy SDMX 2.1 position field — absent on IMF SDMX 3.0. */
            keyPosition?: number;
            localRepresentation?: {
              /**
               * Codelist URN, e.g.
               * `"urn:sdmx:...Codelist=IMF:CL_AREA(1.17.0)"`. Present on the
               * ESTAT- and IAEG-SDGs-authored structures the IMF portal serves
               * (NA_MAIN, SDG); absent entirely on IMF-authored ones, which
               * carry the reference on the concept instead.
               */
              enumeration?: string;
            };
          }>;
        };
      };
    }>;
    codelists?: Array<{
      id: string;
      agencyID?: string;
      version?: string;
      names?: Record<string, string>;
      codes?: Array<{
        id: string;
        names?: Record<string, string>;
      }>;
    }>;
    /**
     * Concept schemes shipped by `?references=all`. Each concept carries the
     * dimension's human-readable label and, on IMF-authored structures, the
     * authoritative codelist reference under `coreRepresentation.enumeration`.
     */
    conceptSchemes?: Array<{
      id: string;
      agencyID?: string;
      version?: string;
      concepts?: Array<SdmxConcept>;
    }>;
  };
}

/** A single concept: the dimension's label plus its codelist reference. */
export interface SdmxConcept {
  /**
   * Default representation for this concept. On IMF-authored DSDs the
   * `enumeration` URN here is the only machine-readable codelist reference —
   * the dimension itself carries no `localRepresentation`.
   */
  coreRepresentation?: { enumeration?: string };
  id: string;
  /** Localized labels, keyed by language tag. `codes[]` and `dataflows[]` use the same shape. */
  names?: Record<string, string>;
}
