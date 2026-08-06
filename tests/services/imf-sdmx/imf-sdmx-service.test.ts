/**
 * @fileoverview Tests for ImfSdmxService — DSD resolution via the dataflow's own
 * `structure` URN, codelist resolution across all three reference paths, dimension
 * labels from the concept schemes, and the dataflow-vs-DSD identity merge. Covers
 * #10 (codelists resolve for ER's suffixed DSD_ER_PUB and IIP's shared DSD_BOP),
 * #12 (the flow's own name/version/agency are preserved; the DSD's version/id are
 * exposed additively), #20 (dimensions whose codelist no naming convention can
 * name), and #28 (dimension labels).
 *
 * Fixtures are modeled on the live api.imf.org SDMX 3.0 response shapes: dataflow
 * `structure` is a URN string; `localRepresentation.enumeration` is a Codelist URN
 * string on ESTAT/IAEG-SDGs structures and absent on IMF-authored ones, which cite
 * the codelist from the concept's `coreRepresentation` instead; URN versions carry
 * a `+` wildcard and routinely trail the shipped codelist's patch.
 *
 * The ER/IIP fixtures deliberately ship NO concept schemes — they are the guard
 * that the IMF naming convention still resolves for structures neither URN covers.
 * The GS_ED fixture is the opposite guard: both paths resolve and they disagree,
 * so it pins the URN ahead of the convention.
 *
 * @module tests/services/imf-sdmx/imf-sdmx-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import type { StorageService } from '@cyanheads/mcp-ts-core/storage';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchWithTimeout } = vi.hoisted(() => ({ fetchWithTimeout: vi.fn() }));
vi.mock('@cyanheads/mcp-ts-core/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cyanheads/mcp-ts-core/utils')>();
  return { ...actual, fetchWithTimeout };
});

import { ImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

// --- Fixtures (real api.imf.org SDMX 3.0 shapes) --------------------------------

/** The real 10 INDICATOR codes from CL_ER_INDICATOR_PUB (IMF.STA v1.0.0). */
const ER_INDICATOR_CODES = [
  { id: 'ECU_XDC', names: { en: 'ECU per domestic currency' } },
  { id: 'EUR_XDC', names: { en: 'Euros per domestic currency' } },
  { id: 'XDC_ECU', names: { en: 'Domestic currency per ECU' } },
  { id: 'XDC_EUR', names: { en: 'Domestic currency per Euro' } },
  { id: 'XDC_XDR', names: { en: 'Domestic currency per SDR' } },
  { id: 'XDC_USD', names: { en: 'Domestic currency per US Dollar' } },
  { id: 'XDR_XDC', names: { en: 'SDR per domestic currency' } },
  { id: 'XDR_USD', names: { en: 'SDR per US Dollar' } },
  { id: 'USD_XDC', names: { en: 'US Dollar per domestic currency' } },
  { id: 'USD_XDR', names: { en: 'US Dollar per SDR' } },
];

/** CL_BOP_INDICATOR carries 979 codes live; the shape (id + names.en) is real. */
const BOP_INDICATOR_CODES = Array.from({ length: 979 }, (_, i) => ({
  id: `BOP_IND_${i}`,
  names: { en: `BOP indicator ${i}` },
}));

const DATAFLOW_LIST = {
  data: {
    dataflows: [
      {
        id: 'ER',
        agencyID: 'IMF.STA',
        version: '4.0.1',
        names: { en: 'Exchange Rates (ER)' },
        // Suffixed DSD, versioned independently of the flow (flow 4.0.1 / DSD 4.0.0).
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_ER_PUB(4.0+.0)',
      },
      {
        id: 'IIP',
        agencyID: 'IMF.STA',
        version: '13.0.0',
        names: { en: 'International Investment Position (IIP)' },
        // IIP legitimately reuses the shared Balance of Payments structure.
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_BOP(24.0+.0)',
      },
      {
        // No `structure` URN — forces the dataflow-endpoint fallback path.
        id: 'NOURN',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        names: { en: 'No URN Flow' },
      },
      {
        // URN points to a DSD id that returns HTTP 204 — exercises the
        // non-retryable short-circuit + fallback.
        id: 'MISS',
        agencyID: 'IMF.STA',
        version: '2.0.0',
        names: { en: 'Missing DSD Flow' },
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_MISSING(9.0+.0)',
      },
      {
        // ESTAT-authored structure — dimensions carry a string enumeration URN.
        id: 'NA_MAIN',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        names: { en: 'National Accounts Main Aggregates' },
        structure: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=ESTAT:NA_MAIN(2.1.0)',
      },
      {
        // IMF-authored structure — no localRepresentation anywhere; the codelist
        // reference lives on the concept.
        id: 'CTOT',
        agencyID: 'IMF.RES',
        version: '5.0.1',
        names: { en: 'Commodity Terms of Trade (CTOT)' },
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.RES:DSD_CTOT(6.0+.0)',
      },
      {
        id: 'LS',
        agencyID: 'IMF.STA',
        version: '9.0.0',
        names: { en: 'Labor Statistics (LS)' },
        structure: 'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_LS(9.0+.0)',
      },
      {
        id: 'DIP',
        agencyID: 'IMF.STA',
        version: '12.0.1',
        names: { en: 'Direct Investment Positions (DIP)' },
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_DIP(13.0+.0)',
      },
      {
        // Both a convention-named and a URN-named codelist ship for the same
        // dimension, so the two resolution paths disagree — this flow pins which wins.
        id: 'GS_ED',
        agencyID: 'IMF.STA',
        version: '2.0.0',
        names: { en: 'Gender Statistics: Education (GS_ED)' },
        structure:
          'urn:sdmx:org.sdmx.infomodel.datastructure.DataStructure=IMF.STA:DSD_GS_ED(2.0+.0)',
      },
    ],
  },
};

/** DSD_ER_PUB — suffixed DSD; INDICATOR codelist carries the `_PUB` suffix. */
const ER_DSD = {
  data: {
    dataStructures: [
      {
        id: 'DSD_ER_PUB',
        agencyID: 'IMF.STA',
        version: '4.0.0',
        names: { en: 'Exchange Rates (ER)' },
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'COUNTRY',
                position: 0,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_ER_PUB(5.0+.0).COUNTRY',
              },
              {
                id: 'INDICATOR',
                position: 1,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_ER_PUB(5.0+.0).INDICATOR',
              },
              {
                // Dimension id FREQUENCY but concept id FREQ — resolves via concept.
                id: 'FREQUENCY',
                position: 3,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF:CS_MASTER_SYSTEM(1.0).FREQ',
              },
            ],
          },
        },
      },
    ],
    codelists: [
      {
        id: 'CL_ER_INDICATOR_PUB',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        codes: ER_INDICATOR_CODES,
      },
      {
        id: 'CL_ER_COUNTRY_PUB',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        codes: [
          { id: 'USA', names: { en: 'United States' } },
          { id: 'GBR', names: { en: 'United Kingdom' } },
        ],
      },
      {
        id: 'CL_FREQ',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        codes: [
          { id: 'A', names: { en: 'Annual' } },
          { id: 'M', names: { en: 'Monthly' } },
        ],
      },
    ],
  },
};

/** DSD_BOP — shared structure; note NO CL_IIP_INDICATOR exists, only CL_BOP_INDICATOR. */
const BOP_DSD = {
  data: {
    dataStructures: [
      {
        id: 'DSD_BOP',
        agencyID: 'IMF.STA',
        version: '24.0.0',
        names: { en: 'Balance of Payments (BOP)' },
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'COUNTRY',
                position: 0,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_BOP(1.0).COUNTRY',
              },
              {
                id: 'INDICATOR',
                position: 2,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_BOP(1.0).INDICATOR',
              },
              {
                id: 'FREQUENCY',
                position: 4,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF:CS_MASTER_SYSTEM(1.0).FREQ',
              },
            ],
          },
        },
      },
    ],
    codelists: [
      {
        id: 'CL_BOP_INDICATOR',
        agencyID: 'IMF.STA',
        version: '10.0.0',
        codes: BOP_INDICATOR_CODES,
      },
      {
        id: 'CL_COUNTRY',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        codes: [{ id: 'USA', names: { en: 'United States' } }],
      },
      {
        id: 'CL_FREQ',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        codes: [{ id: 'A', names: { en: 'Annual' } }],
      },
    ],
  },
};

/**
 * NA_MAIN — ESTAT-authored. Every dimension carries a string `localRepresentation.
 * enumeration` Codelist URN, and REF_AREA/COUNTERPART_AREA both point at the same
 * CL_AREA. No codelist here is named CL_NA_MAIN_* or CL_REF_AREA, so the naming
 * convention cannot reach any of them.
 */
const NA_MAIN_DSD = {
  data: {
    dataStructures: [
      {
        id: 'NA_MAIN',
        agencyID: 'ESTAT',
        version: '2.1.0',
        names: { en: 'National accounts main aggregates' },
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'REF_AREA',
                position: 2,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=ESTAT:CS_NA(1.17.0).REF_AREA',
                localRepresentation: {
                  enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF:CL_AREA(1.17.0)',
                },
              },
              {
                id: 'COUNTERPART_AREA',
                position: 3,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=ESTAT:CS_NA(1.17.0).COUNTERPART_AREA',
                localRepresentation: {
                  enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF:CL_AREA(1.17.0)',
                },
              },
              {
                id: 'STO',
                position: 7,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=ESTAT:CS_NA(1.17.0).STO',
                localRepresentation: {
                  enumeration:
                    'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=ESTAT:CL_NA_STO(1.16.0)',
                },
              },
            ],
          },
        },
      },
    ],
    codelists: [
      {
        id: 'CL_AREA',
        agencyID: 'IMF',
        version: '1.17.0',
        codes: [
          { id: 'USA', names: { en: 'United States' } },
          { id: 'W0', names: { en: 'World' } },
        ],
      },
      {
        id: 'CL_NA_STO',
        agencyID: 'ESTAT',
        version: '1.16.0',
        codes: [{ id: 'B1GQ', names: { en: 'Gross domestic product at market prices' } }],
      },
    ],
    conceptSchemes: [
      {
        id: 'CS_NA',
        agencyID: 'ESTAT',
        version: '1.17.0',
        concepts: [
          { id: 'REF_AREA', name: 'Reference area', names: { en: 'Reference area' } },
          { id: 'COUNTERPART_AREA', name: 'Counterpart area', names: { en: 'Counterpart area' } },
          {
            id: 'STO',
            name: 'Stocks, Transactions, Other Flows',
            names: { en: 'Stocks, Transactions, Other Flows' },
          },
        ],
      },
    ],
  },
};

/**
 * DSD_CTOT — IMF-authored. No dimension carries `localRepresentation`; the codelist
 * reference is the concept's `coreRepresentation.enumeration`. Two shapes the naming
 * convention misses: WGT_TYPE (codelist token is WEIGHT_TYPE, not the dimension id)
 * and INDICATOR (URN cites 2.0.0, shipped at 2.0.1 — the version key must widen).
 */
const CTOT_DSD = {
  data: {
    dataStructures: [
      {
        id: 'DSD_CTOT',
        agencyID: 'IMF.RES',
        version: '6.0.0',
        names: { en: 'Commodity Terms of Trade (CTOT)' },
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'INDICATOR',
                position: 1,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.RES:CS_CTOT(4.0+.0).INDICATOR',
              },
              {
                id: 'WGT_TYPE',
                position: 2,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.RES:CS_CTOT(4.0+.0).WGT_TYPE',
              },
              {
                // No concept ships for this dimension — label falls back to the id.
                id: 'FREQUENCY',
                position: 3,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF:CS_MASTER_SYSTEM(1.0+.0).FREQ',
              },
            ],
          },
        },
      },
    ],
    codelists: [
      {
        // Shipped a patch ahead of the version the concept URN cites.
        id: 'CL_CTOT_INDICATOR',
        agencyID: 'IMF.RES',
        version: '2.0.1',
        codes: [{ id: 'XCTOT', names: { en: 'Commodity terms of trade index' } }],
      },
      {
        id: 'CL_CTOT_WEIGHT_TYPE',
        agencyID: 'IMF.RES',
        version: '1.0.0',
        codes: [
          { id: 'FIXED', names: { en: 'Fixed weights' } },
          { id: 'ROLLING', names: { en: 'Rolling weights' } },
        ],
      },
      {
        id: 'CL_FREQ',
        agencyID: 'IMF',
        version: '1.2.0',
        codes: [{ id: 'A', names: { en: 'Annual' } }],
      },
    ],
    conceptSchemes: [
      {
        id: 'CS_CTOT',
        agencyID: 'IMF.RES',
        version: '4.0.0',
        concepts: [
          {
            id: 'INDICATOR',
            name: 'Indicator',
            names: { en: 'Indicator' },
            coreRepresentation: {
              enumeration:
                'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF.RES:CL_CTOT_INDICATOR(2.0+.0)',
            },
          },
          {
            id: 'WGT_TYPE',
            name: 'Weight Type',
            names: { en: 'Weight Type' },
            coreRepresentation: {
              enumeration:
                'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF.RES:CL_CTOT_WEIGHT_TYPE(1.0+.0)',
            },
          },
        ],
      },
    ],
  },
};

/**
 * DSD_LS — the upstream casing typo. The shipped codelist is
 * `CL_LS_TYPE_OF_TRANSFORMAtION`; a case-sensitive convention lookup built from the
 * dimension id yields `CL_LS_TYPE_OF_TRANSFORMATION` and misses. The concept URN
 * cites the typo verbatim, so no case-insensitive keying is needed to resolve it.
 */
const LS_DSD = {
  data: {
    dataStructures: [
      {
        id: 'DSD_LS',
        agencyID: 'IMF.STA',
        version: '9.0.0',
        names: { en: 'Labor Statistics (LS)' },
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'TYPE_OF_TRANSFORMATION',
                position: 2,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_LS(1.0+.0).TYPE_OF_TRANSFORMATION',
              },
            ],
          },
        },
      },
    ],
    codelists: [
      {
        id: 'CL_LS_TYPE_OF_TRANSFORMAtION',
        agencyID: 'IMF.STA',
        version: '1.0.1',
        codes: [{ id: 'IX', names: { en: 'Index' } }],
      },
    ],
    conceptSchemes: [
      {
        id: 'CS_LS',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        concepts: [
          {
            id: 'TYPE_OF_TRANSFORMATION',
            name: 'Type of transformations',
            names: { en: 'Type of transformations' },
            coreRepresentation: {
              enumeration:
                'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF.STA:CL_LS_TYPE_OF_TRANSFORMAtION(1.0+.0)',
            },
          },
        ],
      },
    ],
  },
};

/**
 * DSD_DIP — a counterpart dimension that reuses the primary codelist. No
 * `CL_DIP_COUNTERPART_COUNTRY` exists, so the convention has nothing to find;
 * both COUNTRY and COUNTERPART_COUNTRY cite `CL_DIP_COUNTRY`.
 */
const DIP_DSD = {
  data: {
    dataStructures: [
      {
        id: 'DSD_DIP',
        agencyID: 'IMF.STA',
        version: '13.0.0',
        names: { en: 'Direct Investment Positions (DIP)' },
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'COUNTRY',
                position: 0,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_DIP(1.0+.0).COUNTRY',
              },
              {
                id: 'COUNTERPART_COUNTRY',
                position: 3,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_DIP(1.0+.0).COUNTERPART_COUNTRY',
              },
            ],
          },
        },
      },
    ],
    codelists: [
      {
        id: 'CL_DIP_COUNTRY',
        agencyID: 'IMF.STA',
        version: '3.0.0',
        codes: [
          { id: 'USA', names: { en: 'United States' } },
          { id: 'JPN', names: { en: 'Japan' } },
        ],
      },
    ],
    conceptSchemes: [
      {
        id: 'CS_DIP',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        concepts: [
          {
            id: 'COUNTRY',
            name: 'Country',
            names: { en: 'Country' },
            coreRepresentation: {
              enumeration:
                'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF.STA:CL_DIP_COUNTRY(3.0+.0)',
            },
          },
          {
            id: 'COUNTERPART_COUNTRY',
            name: 'Counterpart Country',
            names: { en: 'Counterpart Country' },
            coreRepresentation: {
              enumeration:
                'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF.STA:CL_DIP_COUNTRY(3.0+.0)',
            },
          },
        ],
      },
    ],
  },
};

/**
 * DSD_GS_ED — the shape where the two resolution paths disagree, modeled on the
 * live Gender Statistics structures. `CL_GENDER` ships and the naming convention
 * finds it via `CL_<DIM>`; the concept URN names `CL_SEX` instead, and `CL_SEX`
 * is the codelist whose codes the flow's data actually uses. Ordering the URN
 * ahead of the convention is what picks the right one — swap the two and this
 * dimension silently resolves a 3-code superset the data never emits.
 */
const GS_ED_DSD = {
  data: {
    dataStructures: [
      {
        id: 'DSD_GS_ED',
        agencyID: 'IMF.STA',
        version: '2.0.0',
        names: { en: 'Gender Statistics: Education (GS_ED)' },
        dataStructureComponents: {
          dimensionList: {
            dimensions: [
              {
                id: 'GENDER',
                position: 4,
                conceptIdentity:
                  'urn:sdmx:org.sdmx.infomodel.conceptscheme.Concept=IMF.STA:CS_GS(1.0+.0).GENDER',
              },
            ],
          },
        },
      },
    ],
    codelists: [
      {
        // What the naming convention reaches — a wider set including gender
        // identities that carry no observations.
        id: 'CL_GENDER',
        agencyID: 'IMF',
        version: '1.0.0',
        codes: [
          { id: 'M', names: { en: 'Male' } },
          { id: 'W', names: { en: 'Woman' } },
          { id: 'NB', names: { en: 'Non-binary' } },
        ],
      },
      {
        // What the concept URN names, and what the data uses.
        id: 'CL_SEX',
        agencyID: 'IMF',
        version: '1.1.0',
        codes: [
          { id: 'F', names: { en: 'Female' } },
          { id: 'M', names: { en: 'Male' } },
          { id: '_T', names: { en: 'Total' } },
        ],
      },
    ],
    conceptSchemes: [
      {
        id: 'CS_GS',
        agencyID: 'IMF.STA',
        version: '1.0.0',
        concepts: [
          {
            id: 'GENDER',
            names: { en: 'Gender' },
            coreRepresentation: {
              enumeration: 'urn:sdmx:org.sdmx.infomodel.codelist.Codelist=IMF:CL_SEX(1.0+.0)',
            },
          },
        ],
      },
    ],
  },
};

/** Fallback (dataflow endpoint, references=all) responses — flow + its DSD inline. */
const NOURN_FALLBACK = {
  data: {
    dataflows: [
      { id: 'NOURN', agencyID: 'IMF.STA', version: '1.0.0', names: { en: 'No URN Flow' } },
    ],
    dataStructures: BOP_DSD.data.dataStructures,
    codelists: BOP_DSD.data.codelists,
  },
};
const MISS_FALLBACK = {
  data: {
    dataflows: [
      { id: 'MISS', agencyID: 'IMF.STA', version: '2.0.0', names: { en: 'Missing DSD Flow' } },
    ],
    dataStructures: BOP_DSD.data.dataStructures,
    codelists: BOP_DSD.data.codelists,
  },
};

// --- Mock fetch router ----------------------------------------------------------

const mkResp = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  text: () => Promise.resolve(body == null ? '' : JSON.stringify(body)),
});

function route(url: string) {
  // Primary DSD fetch: /structure/datastructure/{agency}/{dsdId}/{version}
  if (url.includes('/structure/datastructure/')) {
    if (url.includes('DSD_ER_PUB')) return mkResp(200, ER_DSD);
    if (url.includes('DSD_BOP')) return mkResp(200, BOP_DSD);
    if (url.includes('NA_MAIN')) return mkResp(200, NA_MAIN_DSD);
    if (url.includes('DSD_CTOT')) return mkResp(200, CTOT_DSD);
    if (url.includes('DSD_LS')) return mkResp(200, LS_DSD);
    if (url.includes('DSD_DIP')) return mkResp(200, DIP_DSD);
    if (url.includes('DSD_GS_ED')) return mkResp(200, GS_ED_DSD);
    return mkResp(204, null); // e.g. DSD_MISSING — definitive miss
  }
  // Fallback: /structure/dataflow/{agency}/{flow}/{version}
  const fb = /\/structure\/dataflow\/[^/]+\/([^/]+)\//.exec(url);
  if (fb) {
    if (fb[1] === 'NOURN') return mkResp(200, NOURN_FALLBACK);
    if (fb[1] === 'MISS') return mkResp(200, MISS_FALLBACK);
    return mkResp(204, null);
  }
  // Dataflow list: /structure/dataflow
  if (url.includes('/structure/dataflow')) return mkResp(200, DATAFLOW_LIST);
  return mkResp(204, null);
}

// --- Tests ----------------------------------------------------------------------

describe('ImfSdmxService.fetchDataflowStructure', () => {
  let svc: ImfSdmxService;

  beforeEach(() => {
    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockImplementation((url: string) => Promise.resolve(route(url)));
    // ImfSdmxService never reads config/storage (caching goes through ctx.state).
    svc = new ImfSdmxService(
      {} as AppConfig,
      {} as StorageService,
      'https://api.imf.org/external/sdmx/3.0',
      30_000,
    );
  });

  const findDim = (s: Awaited<ReturnType<ImfSdmxService['fetchDataflowStructure']>>, id: string) =>
    s.dimensions.find((d) => d.id === id);

  // -- #10: codelist resolution ------------------------------------------------

  it('#10 resolves the suffixed _PUB codelist for ER INDICATOR (CL_ER_INDICATOR_PUB, 10 codes)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('ER', undefined, undefined, ctx);

    const indicator = findDim(s, 'INDICATOR');
    expect(indicator?.codelist).toHaveLength(10);
    expect(indicator?.codelist[0]).toEqual({ id: 'ECU_XDC', name: 'ECU per domestic currency' });
  });

  it('#10 resolves every ER dimension (COUNTRY via _PUB, FREQUENCY via concept id → CL_FREQ)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('ER', undefined, undefined, ctx);

    // COUNTRY → CL_ER_COUNTRY_PUB (flow-specific, _PUB suffix)
    expect(findDim(s, 'COUNTRY')?.codelist).toHaveLength(2);
    // FREQUENCY dim id ≠ concept id (FREQ) → resolves via the concept-derived CL_FREQ
    expect(findDim(s, 'FREQUENCY')?.codelist.map((c) => c.id)).toEqual(['A', 'M']);
    // No dimension is left with an empty codelist.
    expect(s.dimensions.every((d) => d.codelist.length > 0)).toBe(true);
  });

  it('#10 resolves a shared DSD via the DSD-own id, not the queried flow id (IIP → CL_BOP_INDICATOR, 979 codes)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('IIP', undefined, undefined, ctx);

    // The fixture has NO CL_IIP_INDICATOR — resolving 979 proves the flow token
    // came from DSD_BOP, not the queried "IIP".
    expect(findDim(s, 'INDICATOR')?.codelist).toHaveLength(979);
    expect(s.keyFormat).toBe('COUNTRY.INDICATOR.FREQUENCY');
  });

  it('#10 fetches the DSD named in the URN with the +stripped version, never a DSD_<flow> guess', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    await svc.fetchDataflowStructure('ER', undefined, undefined, ctx);

    const urls = fetchWithTimeout.mock.calls.map((c) => c[0] as string);
    // The datastructure fetch targets DSD_ER_PUB at the concrete version 4.0.0 ("+" stripped).
    expect(urls.some((u) => u.includes('/datastructure/IMF.STA/DSD_ER_PUB/4.0.0'))).toBe(true);
    // The buggy DSD_<flow> guess is never attempted.
    expect(urls.some((u) => u.includes('DSD_ER/'))).toBe(false);
  });

  // -- #10 root cause 1: don't retry the 204 ----------------------------------

  it('#10 treats a 204 DSD response as a definitive miss (no retry storm) and falls back', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('MISS', undefined, undefined, ctx);

    // The 204'd DSD id is fetched exactly once — retryable:false skips the retry budget.
    const missCalls = fetchWithTimeout.mock.calls.filter((c) =>
      (c[0] as string).includes('DSD_MISSING'),
    );
    expect(missCalls).toHaveLength(1);
    // The fallback still resolves the structure.
    expect(findDim(s, 'INDICATOR')?.codelist).toHaveLength(979);
    expect(s.name).toBe('Missing DSD Flow');
  });

  // -- #10 root cause 2: fallback derives the flow token from the DSD's own id --

  it('#10 fallback path (no URN) derives the codelist flow token from dataStructures[0].id', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('NOURN', undefined, undefined, ctx);

    // Fallback response carries DSD_BOP; INDICATOR must resolve via CL_BOP_INDICATOR.
    expect(findDim(s, 'INDICATOR')?.codelist).toHaveLength(979);
    expect(s.dsdId).toBe('DSD_BOP');
  });

  // -- #20: codelists the naming convention cannot name ------------------------

  it('#20 resolves a string enumeration URN on the dimension (NA_MAIN REF_AREA → IMF:CL_AREA)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('NA_MAIN', undefined, undefined, ctx);

    // No CL_NA_MAIN_REF_AREA and no CL_REF_AREA ship, so the convention cannot
    // reach this — only the enumeration URN names IMF:CL_AREA.
    expect(findDim(s, 'REF_AREA')?.codelist).toEqual([
      { id: 'USA', name: 'United States' },
      { id: 'W0', name: 'World' },
    ]);
    expect(findDim(s, 'STO')?.codelist.map((c) => c.id)).toEqual(['B1GQ']);
    expect(s.dimensions.every((d) => d.codelist.length > 0)).toBe(true);
  });

  it('#20 resolves two dimensions onto the same enumerated codelist (NA_MAIN REF_AREA / COUNTERPART_AREA)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('NA_MAIN', undefined, undefined, ctx);

    expect(findDim(s, 'COUNTERPART_AREA')?.codelist.map((c) => c.id)).toEqual(['USA', 'W0']);
  });

  it('#20 resolves via the concept core representation when the dimension has none (CTOT WGT_TYPE → CL_CTOT_WEIGHT_TYPE)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('CTOT', undefined, undefined, ctx);

    // The convention would look for CL_CTOT_WGT_TYPE, which does not exist —
    // the concept names CL_CTOT_WEIGHT_TYPE instead.
    expect(findDim(s, 'WGT_TYPE')?.codelist).toEqual([
      { id: 'FIXED', name: 'Fixed weights' },
      { id: 'ROLLING', name: 'Rolling weights' },
    ]);
    // INDICATOR reaches the same codelist by either route — asserted so the
    // concept path is shown not to cost the dimensions the convention did resolve.
    expect(findDim(s, 'INDICATOR')?.codelist.map((c) => c.id)).toEqual(['XCTOT']);
  });

  it('#20 resolves through an upstream casing typo and a trailing version (LS TYPE_OF_TRANSFORMATION → CL_LS_TYPE_OF_TRANSFORMAtION)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('LS', undefined, undefined, ctx);

    // Two misses in one dimension: CL_LS_TYPE_OF_TRANSFORMATION (the convention's
    // spelling) is not shipped, and the concept URN cites 1.0.0 while the codelist
    // ships at 1.0.1 — so the version key has to widen to the agency-qualified id.
    expect(findDim(s, 'TYPE_OF_TRANSFORMATION')?.codelist).toEqual([{ id: 'IX', name: 'Index' }]);
  });

  it('#20 resolves a counterpart dimension onto the primary codelist (DIP COUNTERPART_COUNTRY → CL_DIP_COUNTRY)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('DIP', undefined, undefined, ctx);

    // No CL_DIP_COUNTERPART_COUNTRY exists — both dimensions share CL_DIP_COUNTRY.
    expect(findDim(s, 'COUNTERPART_COUNTRY')?.codelist.map((c) => c.id)).toEqual(['USA', 'JPN']);
    expect(findDim(s, 'COUNTRY')?.codelist.map((c) => c.id)).toEqual(['USA', 'JPN']);
  });

  it('#20 prefers the cited codelist URN over a naming-convention match that also exists (GS_ED GENDER → CL_SEX, not CL_GENDER)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('GS_ED', undefined, undefined, ctx);

    // Both codelists ship and both are reachable: CL_GENDER by the CL_<DIM>
    // convention, CL_SEX by the concept URN. The URN is the structure's own
    // reference, so it wins — resolving CL_GENDER here would hand the caller
    // codes (W, NB) the dataflow never emits while omitting F and _T, which it does.
    expect(findDim(s, 'GENDER')?.codelist.map((c) => c.id)).toEqual(['F', 'M', '_T']);
  });

  it('#20 keeps the naming convention for structures that cite no codelist URN (ER, IIP)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    // The ER/IIP fixtures ship no concept schemes and no localRepresentation —
    // resolution here can only come from the convention.
    const er = await svc.fetchDataflowStructure('ER', undefined, undefined, ctx);
    expect(findDim(er, 'INDICATOR')?.codelist).toHaveLength(10);

    const iip = await svc.fetchDataflowStructure('IIP', undefined, undefined, ctx);
    expect(findDim(iip, 'INDICATOR')?.codelist).toHaveLength(979);
  });

  // -- #28: dimension labels from the concept schemes ---------------------------

  it('#28 labels each dimension from its concept rather than echoing the id', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('CTOT', undefined, undefined, ctx);

    const wgt = findDim(s, 'WGT_TYPE');
    expect(wgt?.name).toBe('Weight Type');
    expect(wgt?.name).not.toBe(wgt?.id);
    expect(findDim(s, 'INDICATOR')?.name).toBe('Indicator');
  });

  it('#28 labels dimensions on enumeration-style structures too (NA_MAIN STO → "Stocks, Transactions, Other Flows")', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('NA_MAIN', undefined, undefined, ctx);

    expect(findDim(s, 'STO')?.name).toBe('Stocks, Transactions, Other Flows');
    expect(findDim(s, 'COUNTERPART_AREA')?.name).toBe('Counterpart area');
  });

  it('#28 falls back to the dimension id when the payload ships no matching concept', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    // CTOT's FREQUENCY cites CS_MASTER_SYSTEM, which the fixture does not ship.
    const ctot = await svc.fetchDataflowStructure('CTOT', undefined, undefined, ctx);
    expect(findDim(ctot, 'FREQUENCY')?.name).toBe('FREQUENCY');

    // ER ships no concept schemes at all — every label falls back.
    const er = await svc.fetchDataflowStructure('ER', undefined, undefined, ctx);
    expect(er.dimensions.every((d) => d.name === d.id)).toBe(true);
  });

  // -- #12: identity merge -----------------------------------------------------

  it('#12 preserves the flow’s own name/version/agency and exposes the DSD identity additively', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('IIP', undefined, undefined, ctx);

    // Flow identity — NOT the shared DSD's ("Balance of Payments (BOP)" / 24.0.0).
    expect(s.name).toBe('International Investment Position (IIP)');
    expect(s.version).toBe('13.0.0');
    expect(s.agencyId).toBe('IMF.STA');
    expect(s.dataflowId).toBe('IIP');
    // DSD identity surfaced separately.
    expect(s.dsdVersion).toBe('24.0.0');
    expect(s.dsdId).toBe('DSD_BOP');
  });

  it('#12 pins version to the flow even when only the patch differs (ER 4.0.1 vs DSD 4.0.0)', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const s = await svc.fetchDataflowStructure('ER', undefined, undefined, ctx);

    expect(s.version).toBe('4.0.1'); // flow's own version
    expect(s.dsdVersion).toBe('4.0.0'); // DSD_ER_PUB's version
    expect(s.name).toBe('Exchange Rates (ER)');
  });
});

// --- #24: dataflow-list error boundary -------------------------------------------

/**
 * The configured base URL points at a private mirror here, not the public portal —
 * IMF_BASE_URL is user-configurable, so leaking it discloses deployment topology.
 */
const PRIVATE_BASE_URL = 'https://sdmx-mirror.internal.example/external/sdmx/3.0';
const UPSTREAM_BODY = '{"statusCode":404,"message":"Resource not found","trace":"mirror-node-7"}';

/**
 * The exact shape `fetchWithTimeout` throws on a non-2xx: the resolved URL in the
 * message plus the upstream body under both the canonical and legacy field names.
 */
const leakyFetchError = (url: string) =>
  new McpError(JsonRpcErrorCode.NotFound, `Fetch failed for ${url}. Status: 404`, {
    status: 404,
    statusText: 'Not Found',
    body: UPSTREAM_BODY,
    statusCode: 404,
    responseBody: UPSTREAM_BODY,
    errorSource: 'FetchHttpError',
  });

/** Everything a client can read off a thrown error, flattened for substring assertions. */
const serializeError = (err: unknown) =>
  JSON.stringify({
    message: err instanceof Error ? err.message : String(err),
    data: err instanceof McpError ? err.data : undefined,
  });

describe('ImfSdmxService.fetchDataflows error boundary (#24)', () => {
  let svc: ImfSdmxService;

  beforeEach(() => {
    fetchWithTimeout.mockReset();
    fetchWithTimeout.mockImplementation((url: string) =>
      Promise.reject(leakyFetchError(url as string)),
    );
    svc = new ImfSdmxService({} as AppConfig, {} as StorageService, PRIVATE_BASE_URL, 30_000);
  });

  it('leaks neither the configured base URL nor the upstream body into the client error', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const err = await svc.fetchDataflows(ctx).then(
      () => {
        throw new Error('expected fetchDataflows to reject');
      },
      (e: unknown) => e,
    );

    // Assert on everything the client can see, not one field.
    const wire = serializeError(err);
    expect(wire).not.toContain('sdmx-mirror.internal.example');
    expect(wire).not.toContain('/structure/dataflow');
    expect(wire).not.toContain('Resource not found');
    expect(wire).not.toContain('mirror-node-7');
    expect(wire).not.toContain('responseBody');
    expect(wire).not.toContain('Fetch failed');
  });

  it('rethrows a ServiceUnavailable carrying dataflow_list_unavailable and a retry hint', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    await expect(svc.fetchDataflows(ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: {
        reason: 'dataflow_list_unavailable',
        recovery: { hint: expect.stringContaining('Retry') },
      },
    });
  });

  it('sanitizes the same failure when it surfaces through findDataflow', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const err = await svc.findDataflow('WEO', undefined, undefined, ctx).then(
      () => {
        throw new Error('expected findDataflow to reject');
      },
      (e: unknown) => e,
    );

    expect(serializeError(err)).not.toContain('sdmx-mirror.internal.example');
    expect(err).toMatchObject({ data: { reason: 'dataflow_list_unavailable' } });
  });

  it('message avoids "not found" so callers branching on it do not misclassify availability', async () => {
    const ctx = createMockContext({ tenantId: 'test' });

    const err = await svc.fetchDataflows(ctx).catch((e: unknown) => e);
    expect((err as Error).message.toLowerCase()).not.toContain('not found');
  });
});
