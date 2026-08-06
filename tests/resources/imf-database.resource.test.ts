/**
 * @fileoverview Tests for the imf://database/{dataflow_id} resource.
 * @module tests/resources/imf-database.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
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

  it('#28 surfaces the concept label for each dimension rather than repeating the id', async () => {
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dataflowId: 'CTOT',
      name: 'Commodity Terms of Trade (CTOT)',
      dimensions: [
        {
          id: 'WGT_TYPE',
          name: 'Weight Type',
          position: 0,
          codelist: [{ id: 'FIXED', name: 'Fixed weights' }],
        },
        ...MOCK_STRUCTURE.dimensions.slice(1),
      ],
    });

    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'CTOT' });
    const result = (await imfDatabaseResource.handler(params, ctx)) as {
      dimensions: Array<{ id: string; name: string }>;
    };

    // The resource shares normalizeDsd() with the tool, so the label reaches it too.
    expect(result.dimensions[0]).toMatchObject({ id: 'WGT_TYPE', name: 'Weight Type' });
    expect(result.dimensions.every((d) => d.name !== d.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #24: the resource path no longer echoes the upstream URL or response body
  // -------------------------------------------------------------------------

  it('#24 surfaces a controlled dataflow_list_unavailable with no upstream detail', async () => {
    mockSvc.findDataflow.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test' });
    const params = imfDatabaseResource.params.parse({ dataflow_id: 'WEO' });

    const err = (await imfDatabaseResource.handler(params, ctx).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e,
    )) as McpError;

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('dataflow_list_unavailable');

    // The resource previously returned the upstream body verbatim under data.responseBody.
    const wire = JSON.stringify({ message: err.message, data: err.data });
    expect(wire).not.toContain('responseBody');
    expect(wire).not.toContain('/structure/');
    expect(wire).not.toContain('Fetch failed');
  });
});
