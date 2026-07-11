/**
 * @fileoverview Tests for ImfSdmxService — DSD resolution via the dataflow's own
 * `structure` URN, IMF naming-convention codelist lookup (including `_PUB`/shared
 * DSDs), and the dataflow-vs-DSD identity merge. Covers #10 (codelists resolve for
 * ER's suffixed DSD_ER_PUB and IIP's shared DSD_BOP) and #12 (the flow's own
 * name/version/agency are preserved; the DSD's version/id are exposed additively).
 *
 * Fixtures are modeled on the live api.imf.org SDMX 3.0 response shapes: dataflow
 * `structure` is a URN string; dimensions carry `position` + a `conceptIdentity`
 * URN and no `localRepresentation`; codelists follow the CL_<FLOW>_<DIM>[_PUB] /
 * CL_<DIM> naming convention.
 *
 * @module tests/services/imf-sdmx/imf-sdmx-service.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
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
