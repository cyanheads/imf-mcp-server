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

/** Raw SDMX structure response shape. */
export interface SdmxStructureResponse {
  data?: {
    dataflows?: Array<{
      id: string;
      agencyID?: string;
      version?: string;
      names?: Record<string, string>;
      descriptions?: Record<string, string>;
      structure?: { id: string; agencyID?: string; version?: string };
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
              enumeration?: { id?: string; agencyID?: string; version?: string };
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
  };
}
