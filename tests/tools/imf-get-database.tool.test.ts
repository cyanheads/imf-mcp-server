/**
 * @fileoverview Tests for the imf_get_database tool.
 * @module tests/tools/imf-get-database.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    expect(result.dimensions[0].id).toBe('COUNTRY');
    expect(result.dimensions[0].codelist[0]).toEqual({ id: 'USA', name: 'United States' });
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

    const countryDim = result.dimensions[0];
    expect(countryDim.codelist).toHaveLength(50);
    expect(countryDim.codelist_truncated).toBe(true);
  });

  it('does not set codelist_truncated when codelist is within limit', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfGetDatabase.errors });
    const input = imfGetDatabase.input.parse({ dataflow_id: 'WEO' });
    const result = await imfGetDatabase.handler(input, ctx);

    expect(result.dimensions[0].codelist_truncated).toBe(false);
  });

  it('formats output with key_format prominently', () => {
    const output = {
      dataflow_id: 'WEO',
      agency_id: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
      dimensions: [
        {
          id: 'COUNTRY',
          name: 'Country',
          position: 0,
          codelist: [{ id: 'USA', name: 'United States' }],
          codelist_truncated: false,
        },
      ],
    };
    const blocks = imfGetDatabase.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('COUNTRY.INDICATOR.FREQUENCY');
    expect(text).toContain('COUNTRY');
    expect(text).toContain('USA');
    expect(text).toContain('United States');
    expect(text).toContain('World Economic Outlook');
  });

  it('formats truncation notice when codelist_truncated is true', () => {
    const output = {
      dataflow_id: 'WEO',
      agency_id: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
      dimensions: [
        {
          id: 'COUNTRY',
          name: 'Country',
          position: 0,
          codelist: [{ id: 'USA', name: 'United States' }],
          codelist_truncated: true,
        },
      ],
    };
    const blocks = imfGetDatabase.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('truncated');
  });
});
