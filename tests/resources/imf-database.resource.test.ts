/**
 * @fileoverview Tests for the imf://database/{dataflow_id} resource.
 * @module tests/resources/imf-database.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMcpError } from '../helpers/errors.js';

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

/**
 * `params` is optional on ResourceDefinition; this resource declares one, so
 * narrow it once here instead of asserting at every call site.
 */
const resourceParams = imfDatabaseResource.params;
if (!resourceParams) throw new Error('imfDatabaseResource must declare a params schema');

/** Same story for `output` — declared on the definition, optional on the type. */
const resourceOutput = imfDatabaseResource.output;
if (!resourceOutput) throw new Error('imfDatabaseResource must declare an output schema');

/** The contract `recovery` the resource factory puts on the wire for `reason`. */
const declaredRecovery = (reason: string): string =>
  imfDatabaseResource.errors?.find((entry) => entry.reason === reason)?.recovery ?? '';

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
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });
    const result = await imfDatabaseResource.handler(params, ctx);

    expect(result).toMatchObject({
      dataflow_id: 'WEO',
      agency_id: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook',
      key_format: 'COUNTRY.INDICATOR.FREQUENCY',
    });
    expect(result.dimensions).toHaveLength(3);
    expect(result.dimensions[0]).toMatchObject({
      unfiltered_count: 2,
      matched_count: 2,
      returned_count: 2,
      offset: 0,
      codelist_truncated: false,
    });
    expect(result.continuation).toMatchObject({
      tool: 'imf_get_database',
      dataflow_id: 'WEO',
      dimension_selector: 'dimension_id',
      page_limit: 'limit',
      page_offset: 'offset',
    });
  });

  it('parses against the declared output schema, optional fields included', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dsdId: 'DSD_WEO_PUB',
      dsdVersion: '4.0.0',
    });

    const result = await imfDatabaseResource.handler(params, ctx);
    const parsed = resourceOutput.parse(result);

    expect(parsed).toMatchObject({
      dsd_version: '4.0.0',
      structure_ref: 'DSD_WEO_PUB',
      description: 'Biannual WEO projections',
    });
  });

  it('parses against the output schema when every optional field is absent', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });
    const { description: _description, ...minimal } = MOCK_STRUCTURE;
    mockSvc.fetchDataflowStructure.mockResolvedValue(minimal);

    const result = await imfDatabaseResource.handler(params, ctx);
    const parsed = resourceOutput.parse(result);

    expect(parsed.description).toBeUndefined();
    expect(parsed.dsd_version).toBeUndefined();
    expect(parsed.structure_ref).toBeUndefined();
    expect(parsed.dimensions).toHaveLength(3);
  });

  it('includes description when present', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });
    const result = await imfDatabaseResource.handler(params, ctx);

    expect(result.description).toBe('Biannual WEO projections');
  });

  it('#43 declares every reachable resource failure with aligned codes', () => {
    expect(imfDatabaseResource.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'dataflow_not_found',
          code: JsonRpcErrorCode.NotFound,
        }),
        expect.objectContaining({
          reason: 'structure_unavailable',
          code: JsonRpcErrorCode.ServiceUnavailable,
        }),
        expect.objectContaining({
          reason: 'dataflow_list_unavailable',
          code: JsonRpcErrorCode.ServiceUnavailable,
        }),
      ]),
    );
  });

  it('#43 returns dataflow_not_found with actionable recovery for an unknown id', async () => {
    mockSvc.findDataflow.mockResolvedValue(undefined);
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'UNKNOWN' });

    await expect(imfDatabaseResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
    // The resource factory fills the declared recovery onto the wire from the reason.
    expect(declaredRecovery('dataflow_not_found')).toContain('imf_list_databases');
  });

  it('throws NotFound when structure fetch returns not-found error', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(new Error('not found'));
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });

    await expect(imfDatabaseResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
    });
  });

  it('#43 returns structure_unavailable with retry recovery when the DSD fails', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(new Error('connection reset'));
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });

    await expect(imfDatabaseResource.handler(params, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'structure_unavailable' },
    });
    expect(declaredRecovery('structure_unavailable')).toMatch(/retry/i);
  });

  it('#40 bounds codelists at 50 entries and exposes tool continuation metadata', async () => {
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

    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });
    const result = await imfDatabaseResource.handler(params, ctx);

    expect(result.dimensions[0]).toMatchObject({
      unfiltered_count: 80,
      matched_count: 80,
      returned_count: 50,
      offset: 0,
      codelist_truncated: true,
      next_offset: 50,
    });
    expect(result.dimensions[0]?.codelist).toHaveLength(50);
    expect(result.continuation).toMatchObject({
      tool: 'imf_get_database',
      dataflow_id: 'WEO',
    });
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

    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'CTOT' });
    const result = await imfDatabaseResource.handler(params, ctx);

    // The resource shares normalizeDsd() with the tool, so the label reaches it too.
    expect(result.dimensions[0]).toMatchObject({ id: 'WGT_TYPE', name: 'Weight Type' });
    expect(result.dimensions.every((d) => d.name !== d.id)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #24: the resource path no longer echoes the upstream URL or response body
  // -------------------------------------------------------------------------

  it('#24/#43 preserves controlled dataflow_list_unavailable recovery with no upstream detail', async () => {
    mockSvc.findDataflow.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });

    const err = await captureMcpError(() => imfDatabaseResource.handler(params, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(err.data?.recovery).toMatchObject({ hint: expect.stringContaining('Retry') });

    // The resource previously returned the upstream body verbatim under data.responseBody.
    const wire = JSON.stringify({ message: err.message, data: err.data });
    expect(wire).not.toContain('responseBody');
    expect(wire).not.toContain('/structure/');
    expect(wire).not.toContain('Fetch failed');
  });

  it('#24/#43 preserves dataflow_list_unavailable from the structure lookup', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'WEO' });

    const err = await captureMcpError(() => imfDatabaseResource.handler(params, ctx));

    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(err.data?.recovery).toMatchObject({ hint: expect.stringContaining('Retry') });
  });

  // -- #52: imf://database/weo resolves to the catalog spelling ------------------

  /** Echoes the id it was asked for, as the pre-#52 service did with its argument. */
  const structureEchoingArgument = (dataflowId: string) =>
    Promise.resolve({ ...MOCK_STRUCTURE, dataflowId });

  it('#52 resolves a lowercase dataflow_id and echoes the catalog spelling', async () => {
    mockSvc.fetchDataflowStructure.mockImplementation(structureEchoingArgument);
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'weo' });

    const result = resourceOutput.parse(await imfDatabaseResource.handler(params, ctx));

    expect(mockSvc.findDataflow).toHaveBeenCalledWith('weo', undefined, undefined, ctx);
    expect(mockSvc.fetchDataflowStructure).toHaveBeenCalledWith('WEO', 'IMF.RES', '9.0.0', ctx);
    expect(result.dataflow_id).toBe('WEO');
    expect(result.continuation.dataflow_id).toBe('WEO');
  });

  it('#52 names the catalog spelling when the structure of a lowercase dataflow_id is unavailable', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(new Error('connection reset'));
    const ctx = createMockContext({ tenantId: 'test', errors: imfDatabaseResource.errors });
    const params = resourceParams.parse({ dataflow_id: 'weo' });

    const err = await captureMcpError(() => imfDatabaseResource.handler(params, ctx));

    expect(err.data?.reason).toBe('structure_unavailable');
    expect(err.message).toBe("Structure unavailable for dataflow 'WEO'");
    expect(err.data?.dataflowId).toBe('WEO');
  });
});
