/**
 * @fileoverview Tests for the imf_get_database tool.
 * @module tests/tools/imf-get-database.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMcpError } from '../helpers/errors.js';

vi.mock('@/services/imf-sdmx/imf-sdmx-service.js', () => ({
  getImfSdmxService: vi.fn(),
}));

import { imfGetDatabase } from '@/mcp-server/tools/definitions/imf-get-database.tool.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const MOCK_DATAFLOW = {
  id: 'WEO',
  agencyId: 'IMF.RES',
  version: '9.0.0',
  name: 'World Economic Outlook',
};

const MOCK_STRUCTURE = {
  dataflowId: 'WEO',
  agencyId: 'IMF.RES',
  version: '9.0.0',
  name: 'World Economic Outlook',
  keyFormat: 'COUNTRY.INDICATOR.FREQUENCY',
  dimensions: [
    {
      id: 'COUNTRY',
      name: 'Country',
      position: 0,
      codelist: [
        { id: 'USA', name: 'United States' },
        { id: 'GBR', name: 'United Kingdom' },
      ],
    },
    {
      id: 'INDICATOR',
      name: 'Indicator',
      position: 1,
      codelist: [{ id: 'NGDP_RPCH', name: 'GDP, Constant prices, Percent change' }],
    },
    {
      id: 'FREQUENCY',
      name: 'Frequency',
      position: 2,
      codelist: [{ id: 'A', name: 'Annual' }],
    },
  ],
};

/**
 * The controlled error ImfSdmxService throws when the dataflow catalog fetch fails
 * (#24). Carries the reason and hint, and nothing about the upstream endpoint.
 */
const dataflowListUnavailable = () =>
  new McpError(
    JsonRpcErrorCode.ServiceUnavailable,
    'IMF dataflow catalog is unavailable — the upstream SDMX structure endpoint did not return a usable response.',
    {
      reason: 'dataflow_list_unavailable',
      recovery: {
        hint: 'Retry in a few moments. The IMF SDMX 3.0 portal is intermittently unavailable.',
      },
    },
  );

describe('imfGetDatabase', () => {
  let mockSvc: {
    findDataflow: ReturnType<typeof vi.fn>;
    fetchDataflowStructure: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSvc = {
      findDataflow: vi.fn().mockResolvedValue(MOCK_DATAFLOW),
      fetchDataflowStructure: vi.fn().mockResolvedValue(MOCK_STRUCTURE),
    };
    (getImfSdmxService as ReturnType<typeof vi.fn>).mockReturnValue(mockSvc);
  });

  it('returns structure with dimensions and key_format', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });
    const result = await imfGetDatabase.handler(input, ctx);

    expect(result.dataflow_id).toBe('WEO');
    expect(result.agency_id).toBe('IMF.RES');
    expect(result.key_format).toBe('COUNTRY.INDICATOR.FREQUENCY');
    expect(result.dimensions).toHaveLength(3);
    expect(result.dimensions[0]!.id).toBe('COUNTRY');
    expect(result.dimensions[0]!.codelist[0]).toEqual({ id: 'USA', name: 'United States' });
    expect(result.source).toBe(
      'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    );
  });

  it('#37 declares external-world access at the tool-definition boundary', () => {
    expect(imfGetDatabase.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });

  it('#12 surfaces dsd_version and structure_ref when the structure carries them', async () => {
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dataflowId: 'IIP',
      name: 'International Investment Position (IIP)',
      version: '13.0.0',
      dsdId: 'DSD_BOP',
      dsdVersion: '24.0.0',
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'IIP' });
    const result = await imfGetDatabase.handler(input, ctx);

    // Flow identity preserved; DSD identity exposed additively.
    expect(result.version).toBe('13.0.0');
    expect(result.name).toBe('International Investment Position (IIP)');
    expect((result as { dsd_version?: string }).dsd_version).toBe('24.0.0');
    expect((result as { structure_ref?: string }).structure_ref).toBe('DSD_BOP');
  });

  it('#12 format renders the DSD structure line when dsd_version/structure_ref are present', () => {
    const output = {
      dataflow_id: 'IIP',
      agency_id: 'IMF.STA',
      version: '13.0.0',
      dsd_version: '24.0.0',
      structure_ref: 'DSD_BOP',
      name: 'International Investment Position (IIP)',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
      truncated: false,
      dimensions: [
        {
          id: 'COUNTRY',
          name: 'Country',
          position: 0,
          codelist: [{ id: 'USA', name: 'United States' }],
          codelist_truncated: false,
          unfiltered_count: 1,
          matched_count: 1,
          returned_count: 1,
          offset: 0,
        },
      ],
      source:
        'Source: International Monetary Fund, International Investment Position (IIP), https://data.imf.org/',
    };
    const blocks = imfGetDatabase.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('DSD_BOP');
    expect(text).toContain('24.0.0');
  });

  it('throws ctx.fail("dataflow_not_found") when dataflow does not exist', async () => {
    mockSvc.findDataflow.mockResolvedValue(undefined);
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'NONEXISTENT' });

    await expect(imfGetDatabase.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail("structure_unavailable") when DSD fetch fails', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(new Error('API timeout'));
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });

    await expect(imfGetDatabase.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'structure_unavailable' },
    });
  });

  it('throws ctx.fail("dataflow_not_found") when DSD fetch returns not-found error', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(new Error('not found'));
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });

    await expect(imfGetDatabase.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('truncates codelists longer than 50 entries', async () => {
    const largeCodelist = Array.from({ length: 60 }, (_, i) => ({
      id: `C${i}`,
      name: `Country ${i}`,
    }));
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [
        { id: 'COUNTRY', name: 'Country', position: 0, codelist: largeCodelist },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });
    const result = await imfGetDatabase.handler(input, ctx);

    const countryDim = result.dimensions[0]!;
    expect(countryDim.codelist).toHaveLength(50);
    expect(countryDim.codelist_truncated).toBe(true);
  });

  it('does not set codelist_truncated when codelist is within limit', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });
    const result = await imfGetDatabase.handler(input, ctx);

    expect(result.dimensions[0]!.codelist_truncated).toBe(false);
  });

  it('formats output with key_format prominently', () => {
    const output = {
      dataflow_id: 'WEO',
      agency_id: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
      truncated: false,
      dimensions: [
        {
          id: 'COUNTRY',
          name: 'Country',
          position: 0,
          codelist: [{ id: 'USA', name: 'United States' }],
          codelist_truncated: false,
          unfiltered_count: 1,
          matched_count: 1,
          returned_count: 1,
          offset: 0,
        },
      ],
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfGetDatabase.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('COUNTRY.INDICATOR.FREQUENCY');
    expect(text).toContain('COUNTRY');
    expect(text).toContain('USA');
    expect(text).toContain('United States');
    expect(text).toContain('World Economic Outlook');
    expect(text).toContain('Source: International Monetary Fund');
    expect(text).toContain('https://data.imf.org/');
  });

  it('formats truncation notice when codelist_truncated is true', () => {
    const output = {
      dataflow_id: 'WEO',
      agency_id: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
      truncated: true,
      dimensions: [
        {
          id: 'COUNTRY',
          name: 'Country',
          position: 0,
          codelist: [{ id: 'USA', name: 'United States' }],
          codelist_truncated: true,
          unfiltered_count: 60,
          matched_count: 60,
          returned_count: 50,
          offset: 0,
          next_offset: 50,
        },
      ],
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfGetDatabase.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('more matches remain');
  });

  // -------------------------------------------------------------------------
  // #8: codelist_filter
  // -------------------------------------------------------------------------

  it('codelist_filter filters by code ID substring (case-insensitive)', async () => {
    const largeCodelist = Array.from({ length: 60 }, (_, i) => ({
      id: `IND_${String(i).padStart(3, '0')}`,
      name: `Indicator ${i}`,
    }));
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [
        {
          ...MOCK_STRUCTURE.dimensions[0],
          codelist: largeCodelist,
        },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO', codelist_filter: 'ind_001' });
    const result = await imfGetDatabase.handler(input, ctx);

    const countryDim = result.dimensions[0]!;
    expect(countryDim.codelist).toHaveLength(1);
    expect(countryDim.codelist[0]!.id).toBe('IND_001');
    // filter mode — not truncated
    expect(countryDim.codelist_truncated).toBe(false);
  });

  it('codelist_filter filters by name substring (case-insensitive)', async () => {
    const codelistWithDescriptions = [
      { id: 'PCPIPCH', name: 'Inflation, average consumer prices' },
      { id: 'NGDP_RPCH', name: 'GDP, Constant prices, Percent change' },
      { id: 'BCA', name: 'Current account balance' },
    ];
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [
        { id: 'INDICATOR', name: 'Indicator', position: 0, codelist: codelistWithDescriptions },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO', codelist_filter: 'inflation' });
    const result = await imfGetDatabase.handler(input, ctx);

    const dim = result.dimensions[0]!;
    expect(dim.codelist).toHaveLength(1);
    expect(dim.codelist[0]!.id).toBe('PCPIPCH');
  });

  it('#40 bounds an unselected filtered preview at 50 entries', async () => {
    // 80 entries that all match "match"
    const largeCodelist = Array.from({ length: 80 }, (_, i) => ({
      id: `MATCH_${i}`,
      name: `Match entry ${i}`,
    }));
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [
        { id: 'INDICATOR', name: 'Indicator', position: 0, codelist: largeCodelist },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });

    const response = await runToolContract(imfGetDatabase, {
      dataflow_id: 'WEO',
      codelist_filter: 'match',
    });
    const result = response.structuredContent as Awaited<ReturnType<typeof imfGetDatabase.handler>>;
    const text = (response.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(result.truncated).toBe(true);
    expect(result.dimensions[0]).toMatchObject({
      codelist: expect.arrayContaining([{ id: 'MATCH_0', name: 'Match entry 0' }]),
      unfiltered_count: 80,
      matched_count: 80,
      returned_count: 50,
      offset: 0,
      codelist_truncated: true,
      next_offset: 50,
    });
    expect(result.dimensions[0]!.codelist).toHaveLength(50);
    expect(text).toContain('50 returned');
    expect(text).toContain('80 matched');
    expect(text).toContain('offset=50');
  });

  it('without codelist_filter: behavior unchanged (first 50, truncated flag)', async () => {
    const largeCodelist = Array.from({ length: 60 }, (_, i) => ({
      id: `C${i}`,
      name: `Country ${i}`,
    }));
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [
        { id: 'COUNTRY', name: 'Country', position: 0, codelist: largeCodelist },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });
    const result = await imfGetDatabase.handler(input, ctx);

    expect(result.dimensions[0]).toMatchObject({
      unfiltered_count: 60,
      matched_count: 60,
      returned_count: 50,
      offset: 0,
      codelist_truncated: true,
      next_offset: 50,
    });
    expect(result.truncated).toBe(true);
    expect(result.dimensions[0]!.codelist).toHaveLength(50);
  });

  // -------------------------------------------------------------------------
  // #36: filter validation and normalization
  // -------------------------------------------------------------------------

  it('#36 rejects a whitespace-only codelist_filter at the schema boundary', () => {
    expect(() =>
      imfGetDatabase.input.parse({ dataflow_id: 'WEO', codelist_filter: '   ' }),
    ).toThrow();
  });

  it('#36 trims a padded filter once for matching, structured output, and content[]', async () => {
    const response = await runToolContract(imfGetDatabase, {
      dataflow_id: 'WEO',
      codelist_filter: '  Constant prices  ',
    });
    const structured = response.structuredContent as {
      codelist_filter?: string;
      dimensions: Array<{ codelist: Array<{ id: string }> }>;
    };
    const text = (response.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(structured.codelist_filter).toBe('Constant prices');
    expect(structured.dimensions.flatMap((dimension) => dimension.codelist)).toContainEqual(
      expect.objectContaining({ id: 'NGDP_RPCH' }),
    );
    expect(text).toContain('`Constant prices`');
    expect(text).not.toContain('  Constant prices  ');
  });

  // -------------------------------------------------------------------------
  // #40: selected-dimension pagination and bounded response metadata
  // -------------------------------------------------------------------------

  it('#40 pages one selected dimension through the first, final, and past-end pages', async () => {
    const codelist = Array.from({ length: 55 }, (_, index) => ({
      id: `CODE_${index}`,
      name: `Code ${index}`,
    }));
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [
        { id: 'INDICATOR', name: 'Indicator', position: 0, codelist },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });
    const ctx = () => createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });

    const first = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({
        dataflow_id: 'WEO',
        dimension_id: 'INDICATOR',
        limit: 30,
        offset: 0,
      }),
      ctx(),
    );
    const final = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({
        dataflow_id: 'WEO',
        dimension_id: 'INDICATOR',
        limit: 30,
        offset: 30,
      }),
      ctx(),
    );
    const pastEnd = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({
        dataflow_id: 'WEO',
        dimension_id: 'INDICATOR',
        limit: 30,
        offset: 60,
      }),
      ctx(),
    );

    expect(first.dimensions).toHaveLength(1);
    expect(first.dimensions[0]).toMatchObject({
      id: 'INDICATOR',
      unfiltered_count: 55,
      matched_count: 55,
      returned_count: 30,
      offset: 0,
      codelist_truncated: true,
      next_offset: 30,
    });
    expect(final.dimensions[0]).toMatchObject({
      returned_count: 25,
      offset: 30,
      codelist_truncated: true,
    });
    expect(final.dimensions[0]).not.toHaveProperty('next_offset');
    expect(pastEnd.dimensions[0]).toMatchObject({
      matched_count: 55,
      returned_count: 0,
      offset: 60,
      codelist: [],
      codelist_truncated: true,
    });
    expect(pastEnd.dimensions[0]).not.toHaveProperty('next_offset');
    expect((imfGetDatabase.format!(pastEnd)[0] as { text: string }).text).toContain(
      'offset 60 is past the end',
    );
  });

  it('#40 applies codelist_filter before selected-dimension paging', async () => {
    const codelist = Array.from({ length: 70 }, (_, index) => ({
      id: index % 2 === 0 ? `MATCH_${index}` : `OTHER_${index}`,
      name: `Code ${index}`,
    }));
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [{ id: 'INDICATOR', name: 'Indicator', position: 0, codelist }],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const result = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({
        dataflow_id: 'WEO',
        dimension_id: 'INDICATOR',
        codelist_filter: 'match_',
        limit: 10,
        offset: 10,
      }),
      ctx,
    );

    expect(result.dimensions[0]).toMatchObject({
      unfiltered_count: 70,
      matched_count: 35,
      returned_count: 10,
      offset: 10,
      codelist_truncated: true,
      next_offset: 20,
    });
    expect(result.dimensions[0]!.codelist.every((entry) => entry.id.startsWith('MATCH_'))).toBe(
      true,
    );
  });

  it('#40 rejects paging controls without dimension_id', () => {
    expect(() => imfGetDatabase.input.parse({ dataflow_id: 'WEO', limit: 10 })).toThrow();
    expect(() => imfGetDatabase.input.parse({ dataflow_id: 'WEO', offset: 10 })).toThrow();
  });

  it('#40 returns a declared structured error for an unknown dimension_id', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO', dimension_id: 'UNKNOWN' });

    await expect(imfGetDatabase.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: {
        reason: 'dimension_not_found',
        availableDimensions: ['COUNTRY', 'INDICATOR', 'FREQUENCY'],
      },
    });
  });

  it('#40 distinguishes a filtered zero-match page from an unresolved codelist', async () => {
    const filtered = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({
        dataflow_id: 'WEO',
        dimension_id: 'INDICATOR',
        codelist_filter: 'zzzznomatch',
      }),
      createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors }),
    );
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [{ id: 'EMPTY', name: 'Empty', position: 0, codelist: [] }],
    });
    const unresolved = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({ dataflow_id: 'WEO', dimension_id: 'EMPTY' }),
      createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors }),
    );

    expect(filtered.dimensions[0]).toMatchObject({ unfiltered_count: 1, matched_count: 0 });
    expect(unresolved.dimensions[0]).toMatchObject({ unfiltered_count: 0, matched_count: 0 });
  });

  it('#40 carries page metadata and continuation through structuredContent and content[]', async () => {
    const codelist = Array.from({ length: 55 }, (_, index) => ({
      id: `CODE_${index}`,
      name: `Code ${index}`,
    }));
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [{ id: 'INDICATOR', name: 'Indicator', position: 0, codelist }],
    });

    const response = await runToolContract(imfGetDatabase, {
      dataflow_id: 'WEO',
      dimension_id: 'INDICATOR',
      limit: 20,
      offset: 20,
    });
    const structured = response.structuredContent as {
      dimensions: Array<Record<string, unknown>>;
    };
    const text = (response.content as Array<{ type: string; text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(structured.dimensions[0]).toMatchObject({
      matched_count: 55,
      returned_count: 20,
      offset: 20,
      next_offset: 40,
    });
    expect(structured).toMatchObject({ truncated: true });
    expect(text).toContain('20 returned');
    expect(text).toContain('55 matched');
    expect(text).toContain('offset 20');
    expect(text).toContain('offset=40');
    expect(text).toContain('**Truncated:** true');
  });

  // -------------------------------------------------------------------------
  // #27: a filter miss and an unresolved codelist are distinguishable
  // -------------------------------------------------------------------------

  /** Both causes render `codelist: []` with `codelist_truncated: false`. */
  const emptyEverywhere = () => ({
    ...MOCK_STRUCTURE,
    dimensions: MOCK_STRUCTURE.dimensions.map((d) => ({ ...d, codelist: [] })),
  });

  it('#27 emits a notice naming the filter and the unfiltered counts when nothing matches', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({
      dataflow_id: 'WEO',
      codelist_filter: 'zzzznomatch',
    });
    const result = await imfGetDatabase.handler(input, ctx);

    expect(result.dimensions.every((d) => d.codelist.length === 0)).toBe(true);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('zzzznomatch');
    // The unfiltered counts are what tell the caller the codes exist and the
    // filter is what missed — COUNTRY has 2, INDICATOR 1, FREQUENCY 1.
    expect(notice).toContain('COUNTRY (2)');
    expect(notice).toContain('INDICATOR (1)');
  });

  it('#27 emits a different notice, pointing at the resource, when a dimension has no resolvable codelist', async () => {
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dimensions: [
        { id: 'COUNTERPART_COUNTRY', name: 'Counterpart Country', position: 0, codelist: [] },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });
    const result = await imfGetDatabase.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string;
    expect(notice).toContain('COUNTERPART_COUNTRY');
    expect(notice).toContain('structure did not provide codes');
    // The filter-miss wording must not appear — it would send the caller the wrong way.
    expect(notice).not.toContain('codelist_filter');
    // And no filter echo, which is the structured signal for this cause.
    expect((result as { codelist_filter?: string }).codelist_filter).toBeUndefined();
  });

  it('#27 emits no notice when every dimension resolves and no filter is set', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });
    await imfGetDatabase.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('#27 emits no notice when a filter matches somewhere, even though other dimensions come back empty', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    // "united" hits both COUNTRY codes and neither INDICATOR nor FREQUENCY. The
    // call succeeded, so the filter-miss notice must stay silent — firing it on
    // any empty dimension rather than all of them turns a good result into a
    // false alarm, and the per-dimension line already says which missed.
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO', codelist_filter: 'united' });
    const result = await imfGetDatabase.handler(input, ctx);

    expect(result.dimensions.map((d) => d.codelist.length)).toEqual([2, 0, 0]);
    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('#27 separates the two causes in structuredContent AND content[] end to end', async () => {
    const filtered = await runToolContract(imfGetDatabase, {
      dataflow_id: 'WEO',
      codelist_filter: 'zzzznomatch',
    });
    mockSvc.fetchDataflowStructure.mockResolvedValue(emptyEverywhere());
    const unfiltered = await runToolContract(imfGetDatabase, { dataflow_id: 'WEO' });

    const sc = (r: typeof filtered) => r.structuredContent as Record<string, unknown>;
    const text = (r: typeof filtered) =>
      (r.content as Array<{ type: string; text?: string }>).map((b) => b.text ?? '').join('\n');

    // structuredContent: the notice and the filter echo both land on the wire.
    expect(sc(filtered).notice).toContain('zzzznomatch');
    expect(sc(filtered).codelist_filter).toBe('zzzznomatch');
    expect(sc(unfiltered).notice).toContain('No codelist resolved');
    expect(sc(unfiltered).codelist_filter).toBeUndefined();

    // content[]: the per-dimension line discriminates the cause and the
    // enrichment trailer carries the remediation — both reach content[].
    expect(text(filtered)).toContain('zzzznomatch');
    expect(text(unfiltered)).toContain('structure did not provide codes');
    expect(text(filtered)).not.toContain('no codelist resolved');
    expect(text(unfiltered)).not.toContain('zzzznomatch');
  });

  it('#27 echoes codelist_filter so the two empty causes differ in structuredContent', async () => {
    mockSvc.fetchDataflowStructure.mockResolvedValue(emptyEverywhere());
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const filtered = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({ dataflow_id: 'WEO', codelist_filter: 'zzzznomatch' }),
      ctx,
    );
    const unfiltered = await imfGetDatabase.handler(
      imfGetDatabase.input.parse({ dataflow_id: 'WEO' }),
      createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors }),
    );

    // Identical dimension payloads — the echo is the only structured difference.
    expect(filtered.dimensions).toEqual(unfiltered.dimensions);
    expect((filtered as { codelist_filter?: string }).codelist_filter).toBe('zzzznomatch');
    expect((unfiltered as { codelist_filter?: string }).codelist_filter).toBeUndefined();
  });

  it('#27 renders the two empty causes as different lines in content[]', () => {
    const base = {
      dataflow_id: 'BOP',
      agency_id: 'IMF.STA',
      version: '1.0.0',
      name: 'Balance of Payments',
      key_format: 'COUNTRY',
      truncated: false,
      dimensions: [
        {
          id: 'COUNTRY',
          name: 'Country',
          position: 0,
          codelist: [],
          codelist_truncated: false,
          unfiltered_count: 1,
          matched_count: 0,
          returned_count: 0,
          offset: 0,
        },
      ],
      source: 'Source: International Monetary Fund, Balance of Payments, https://data.imf.org/',
    };

    const filtered = (
      imfGetDatabase.format!({ ...base, codelist_filter: 'zzzznomatch' })[0] as { text: string }
    ).text;
    const unfiltered = (
      imfGetDatabase.format!({
        ...base,
        dimensions: [{ ...base.dimensions[0]!, unfiltered_count: 0 }],
      })[0] as { text: string }
    ).text;

    expect(filtered).not.toBe(unfiltered);
    // Each line names its own cause; neither repeats the remediation, which the
    // filter header and the enrichment notice already carry once.
    expect(filtered).toContain('no matches for codelist_filter `zzzznomatch`');
    expect(unfiltered).toContain('no codelist resolved');
    expect(filtered).not.toContain('no codelist resolved');
    expect(unfiltered).not.toContain('zzzznomatch');
    // The old single line said neither thing.
    expect(filtered).not.toContain('no codelist entries available');
    expect(unfiltered).not.toContain('no codelist entries available');
  });

  // -------------------------------------------------------------------------
  // #19/#40: the description matches the bounded response
  // -------------------------------------------------------------------------

  it('#19/#40 description states the cap and names the selected-dimension paging path', () => {
    const d = imfGetDatabase.description;
    expect(d).not.toContain('dimension list and complete codelist');
    expect(d).toContain('codelist preview');
    expect(d).toContain(`capped at the first ${50} entries`);
    expect(d).toContain('codelist_filter');
    expect(d).toContain('dimension_id');
    expect(d).toContain('limit/offset');
    expect(d).toContain('imf://database/{dataflow_id}');
    expect(d).not.toContain('complete codelists');
  });

  it('truncation notice in format output names the escape hatch', () => {
    const output = {
      dataflow_id: 'WEO',
      agency_id: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
      truncated: true,
      dimensions: [
        {
          id: 'INDICATOR',
          name: 'Indicator',
          position: 0,
          codelist: [{ id: 'NGDP_RPCH', name: 'GDP growth' }],
          codelist_truncated: true,
          unfiltered_count: 80,
          matched_count: 80,
          returned_count: 50,
          offset: 0,
          next_offset: 50,
        },
      ],
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfGetDatabase.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('dimension_id="INDICATOR"');
    expect(text).toContain('offset=50');
  });

  // -------------------------------------------------------------------------
  // #24: dataflow-list failures are declared and not relabeled
  // -------------------------------------------------------------------------

  it('#24 declares dataflow_list_unavailable alongside structure_unavailable', () => {
    const entry = imfGetDatabase.errors?.find((e) => e.reason === 'dataflow_list_unavailable');
    expect(entry?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(entry?.retryable).toBe(true);
  });

  it('#24 keeps the dataflow_list_unavailable reason instead of relabeling it structure_unavailable', async () => {
    mockSvc.findDataflow.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });

    const err = await captureMcpError(() => imfGetDatabase.handler(input, ctx));

    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(err.data?.recovery).toMatchObject({ hint: expect.stringContaining('Retry') });
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain('/structure/');
  });

  it('#24 keeps dataflow_list_unavailable from the structure lookup', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });

    const err = await captureMcpError(() => imfGetDatabase.handler(input, ctx));

    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(err.data?.recovery).toMatchObject({ hint: expect.stringContaining('Retry') });
  });
});
