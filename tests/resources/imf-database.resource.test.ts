/**
 * @fileoverview Tests for the imf://database/{dataflow_id} resource.
 * @module tests/resources/imf-database.resource.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/imf-sdmx/imf-sdmx-service.js', () => ({
  getImfSdmxService: vi.fn(),
}));

import { imfDatabaseResource } from '@/mcp-server/resources/definitions/imf-database.resource.js';
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
  description: 'Biannual WEO projections',
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

describe('imfDatabaseResource', () => {
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

  it('returns dataflow metadata for a known dataflow_id', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'WEO' });
    const result = await imfDatabaseResource.handler(params, ctx);

    expect(result).toMatchObject({
      dataflow_id: 'WEO',
      agency_id: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
    });
    const typed = result as typeof MOCK_STRUCTURE & {
      dimensions: (typeof MOCK_STRUCTURE)['dimensions'];
    };
    expect(typed.dimensions).toHaveLength(3);
    expect(typed.dimensions[0].codelist).toHaveLength(2);
  });

  it('includes description when present', async () => {
    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'WEO' });
    const result = (await imfDatabaseResource.handler(params, ctx)) as Record<string, unknown>;

    expect(result.description).toBe('Biannual WEO projections');
  });

  it('throws NotFound when dataflow_id does not exist', async () => {
    mockSvc.findDataflow.mockResolvedValue(undefined);
    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'UNKNOWN' });

    await expect(imfDatabaseResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws NotFound when structure fetch returns not-found error', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(new Error('not found'));
    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'WEO' });

    await expect(imfDatabaseResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('throws ServiceUnavailable when structure fetch fails with non-notfound error', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(new Error('connection reset'));
    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'WEO' });

    await expect(imfDatabaseResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
    });
  });

  it('returns full codelist (not truncated) unlike the tool', async () => {
    // The resource returns full codelists (no 50-entry cap unlike imf_get_database tool)
    const largeCodelist = Array.from({ length: 80 }, (_, i) => ({
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

    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'WEO' });
    const result = (await imfDatabaseResource.handler(params, ctx)) as {
      dimensions: Array<{ codelist: unknown[] }>;
    };

    expect(result.dimensions[0].codelist).toHaveLength(80);
  });
});
