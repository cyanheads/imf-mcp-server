/**
 * @fileoverview Tests for the imf_query_dataset tool — inline, canvas spillover, and error paths.
 * @module tests/tools/imf-query-dataset.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/services/imf-sdmx/imf-sdmx-service.js', () => ({
  getImfSdmxService: vi.fn(),
}));

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

vi.mock('@cyanheads/mcp-ts-core/canvas', () => ({
  spillover: vi.fn(),
}));

import { spillover } from '@cyanheads/mcp-ts-core/canvas';
import { imfQueryDataset } from '@/mcp-server/tools/definitions/imf-query-dataset.tool.js';
import { getCanvas } from '@/services/canvas/canvas-accessor.js';
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
    { id: 'COUNTRY', name: 'Country', position: 0, codelist: [] },
    { id: 'INDICATOR', name: 'Indicator', position: 1, codelist: [] },
    { id: 'FREQUENCY', name: 'Frequency', position: 2, codelist: [] },
  ],
};

const MOCK_OBSERVATIONS = [
  { time_period: '2020', value: 3.5, status: null },
  { time_period: '2021', value: 5.1, status: 'E' },
  { time_period: '2022', value: 2.8, status: null },
];

const MOCK_SERIES_ATTRS = { unit: 'Percent', scale: null, decimals: 3 };

const MOCK_QUERY_RESULT = {
  dataflowId: 'WEO',
  key: 'USA.NGDP_RPCH.A',
  observations: MOCK_OBSERVATIONS,
  seriesAttributes: MOCK_SERIES_ATTRS,
};

describe('imfQueryDataset', () => {
  let mockSvc: {
    findDataflow: ReturnType<typeof vi.fn>;
    fetchDataflowStructure: ReturnType<typeof vi.fn>;
    fetchData: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSvc = {
      findDataflow: vi.fn().mockResolvedValue(MOCK_DATAFLOW),
      fetchDataflowStructure: vi.fn().mockResolvedValue(MOCK_STRUCTURE),
      fetchData: vi.fn().mockResolvedValue(MOCK_QUERY_RESULT),
    };
    (getImfSdmxService as ReturnType<typeof vi.fn>).mockReturnValue(mockSvc);
    // Default: no canvas
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  });

  it('returns inline observations when canvas is disabled', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
    });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.dataflow_id).toBe('WEO');
    expect(result.key).toBe('USA.NGDP_RPCH.A');
    expect(result.truncated).toBe(false);
    expect(result.observations).toHaveLength(3);
    expect(result.observations[0]).toEqual({ time_period: '2020', value: 3.5, status: null });
    expect(result.series_attributes.unit).toBe('Percent');
    expect(result.observation_count).toBe(3);
    expect(result.canvas_id).toBeUndefined();
    expect(result.source).toBe(
      'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    );
  });

  it('passes start_period and end_period to service', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2020',
      end_period: '2022',
    });
    await imfQueryDataset.handler(input, ctx);

    expect(mockSvc.fetchData).toHaveBeenCalledWith(
      'IMF.RES',
      'WEO',
      '9.0.0',
      'USA.NGDP_RPCH.A',
      '2020',
      '2022',
      expect.anything(),
      expect.anything(),
    );
  });

  it('throws ctx.fail("dataflow_not_found") when dataflow does not exist', async () => {
    mockSvc.findDataflow.mockResolvedValue(undefined);
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'NONE', key: 'X.Y.Z' });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'dataflow_not_found' },
    });
  });

  it('throws ctx.fail("key_dimension_mismatch") when key has wrong segment count', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    // WEO has 3 dimensions; key has only 2 segments
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH' });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.InvalidParams,
      data: { reason: 'key_dimension_mismatch' },
    });
  });

  it('throws ctx.fail("no_data") when observations are empty', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'ZZZ.NGDP_RPCH.A' });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data' },
    });
  });

  it('throws ctx.fail("structure_unavailable") when data fetch fails', async () => {
    mockSvc.fetchData.mockRejectedValue(new Error('connection timeout'));
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'structure_unavailable' },
    });
  });

  it('returns canvas_id and truncated=true when spillover spills', async () => {
    const mockInstance = { canvasId: 'canvas-abc', describe: vi.fn(), query: vi.fn() };
    const mockCanvasSvc = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(mockCanvasSvc);

    const spillResult = {
      spilled: true,
      handle: { tableName: 'spilled_abc123', rowCount: 1000, columns: [] },
      previewRows: [
        {
          dataflow_id: 'WEO',
          key: 'USA.NGDP_RPCH.A',
          time_period: '2020',
          value: 3.5,
          status: null,
          unit: 'Percent',
          scale: null,
          decimals: 3,
        },
      ],
      truncated: false,
    };
    (spillover as ReturnType<typeof vi.fn>).mockResolvedValue(spillResult);

    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-abc');
    expect(result.table_name).toBe('spilled_abc123');
    expect(result.observation_count).toBe(1000);
    // Preview rows surfaced inline
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].time_period).toBe('2020');
    expect(result.source).toBe(
      'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    );
  });

  it('returns inline observations when spillover fits (spilled=false)', async () => {
    const mockInstance = { canvasId: 'canvas-xyz', describe: vi.fn(), query: vi.fn() };
    const mockCanvasSvc = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(mockCanvasSvc);

    // spillover returns fit — all rows fit in preview budget
    (spillover as ReturnType<typeof vi.fn>).mockResolvedValue({
      spilled: false,
      previewRows: MOCK_OBSERVATIONS.map((obs) => ({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        time_period: obs.time_period,
        value: obs.value,
        status: obs.status,
        unit: 'Percent',
        scale: null,
        decimals: 3,
      })),
    });

    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });
    // When spillover fit returns, the handler falls through to the inline path
    const result = await imfQueryDataset.handler(input, ctx);

    // The inline path is taken (no spill → handler hits the bottom return)
    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.observations).toHaveLength(3);
  });

  it('formats inline observations as markdown table', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: MOCK_SERIES_ATTRS,
      observation_count: 3,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfQueryDataset.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('WEO');
    expect(text).toContain('USA.NGDP_RPCH.A');
    expect(text).toContain('2020');
    expect(text).toContain('3.5');
    expect(text).toContain('Percent');
    expect(text).toContain('Source: International Monetary Fund');
    expect(text).toContain('World Economic Outlook');
    expect(text).toContain('https://data.imf.org/');
  });

  it('suppresses scale "0" in format output (upstream no-op sentinel)', () => {
    // Upstream emits scale "0" when scale is absent — it must not be printed.
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: { unit: null, scale: '0', decimals: 0 },
      observation_count: 3,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfQueryDataset.format!(output);
    const text = (blocks[0] as { text: string }).text;
    // "0" scale and null unit — Series line should be omitted entirely
    expect(text).not.toContain('**Series:**');
  });

  it('shows Series line when unit is present even with scale "0"', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: { unit: 'Percent', scale: '0', decimals: 2 },
      observation_count: 3,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfQueryDataset.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('**Series:**');
    expect(text).toContain('Percent');
    // "0" scale must not appear in the output
    expect(text).not.toMatch(/\| 0 \||\| 0$/m);
    // But decimals should still render
    expect(text).toContain('2 decimals');
  });

  it('formats canvas spill path with canvas_id and table_name', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: [],
      series_attributes: MOCK_SERIES_ATTRS,
      observation_count: 5000,
      truncated: true,
      canvas_id: 'canvas-abc',
      table_name: 'spilled_abc123',
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfQueryDataset.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('canvas-abc');
    expect(text).toContain('spilled_abc123');
    expect(text).toContain('5000');
    expect(text).toContain('imf_dataframe_query');
    expect(text).toContain('Source: International Monetary Fund');
  });
});
