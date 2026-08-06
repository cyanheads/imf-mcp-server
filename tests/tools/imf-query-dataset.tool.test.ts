/**
 * @fileoverview Tests for the imf_query_dataset tool — inline, canvas spillover,
 * period-range filtering, and error paths. The period cases assert the periods a
 * caller gets back rather than the shape of any internal comparison, since the
 * defect they guard (#21) was a correct-looking comparison applied to the wrong
 * representation.
 * @module tests/tools/imf-query-dataset.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

describe('imfQueryDataset', () => {
  let mockSvc: {
    findDataflow: ReturnType<typeof vi.fn>;
    fetchDataflowStructure: ReturnType<typeof vi.fn>;
    fetchData: ReturnType<typeof vi.fn>;
    fetchAvailabilityConstraint: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockSvc = {
      findDataflow: vi.fn().mockResolvedValue(MOCK_DATAFLOW),
      fetchDataflowStructure: vi.fn().mockResolvedValue(MOCK_STRUCTURE),
      fetchData: vi.fn().mockResolvedValue(MOCK_QUERY_RESULT),
      // Default: availability unavailable (degrade gracefully)
      fetchAvailabilityConstraint: vi.fn().mockResolvedValue(null),
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
      code: JsonRpcErrorCode.ValidationError,
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

  // -------------------------------------------------------------------------
  // #7: null-padding filter
  // -------------------------------------------------------------------------

  it('filters null-value + null-status padding rows from returned observations', async () => {
    const withPadding = [
      { series_key: 'FRA.CPI.M', time_period: '1900-M01', value: null, status: null }, // padding
      { series_key: 'FRA.CPI.M', time_period: '1900-M02', value: null, status: null }, // padding
      { series_key: 'FRA.CPI.M', time_period: '1955-M01', value: 42.3, status: null }, // real
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: withPadding });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    // Key with 3 segments to match MOCK_STRUCTURE (COUNTRY.INDICATOR.FREQUENCY)
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'FRA.CPI.M' });
    const result = await imfQueryDataset.handler(input, ctx);

    // Only the real observation should be returned
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0].time_period).toBe('1955-M01');
    expect(result.observations[0].value).toBe(42.3);
    expect(result.observation_count).toBe(1);
  });

  it('preserves null-value rows where status is non-null (official missing-value markers)', async () => {
    const withStatusRow = [
      { series_key: 'USA.CPI.M', time_period: '2020-M01', value: null, status: 'E' }, // keep — has status
      { series_key: 'USA.CPI.M', time_period: '2020-M02', value: null, status: null }, // drop — padding
      { series_key: 'USA.CPI.M', time_period: '2020-M03', value: 105.5, status: null }, // keep — has value
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: withStatusRow });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.CPI.M' });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.observations).toHaveLength(2);
    expect(result.observations.some((o) => o.status === 'E')).toBe(true);
    expect(result.observations.some((o) => o.value === 105.5)).toBe(true);
  });

  it('throws no_data when all observations are null-padding (post-filter)', async () => {
    const allPadding = [
      { series_key: 'FRA.CPI.M', time_period: '1900-M01', value: null, status: null },
      { series_key: 'FRA.CPI.M', time_period: '1900-M02', value: null, status: null },
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: allPadding });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'FRA.CPI.M' });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'no_data' },
    });
  });

  // -------------------------------------------------------------------------
  // #6: period filtering
  // -------------------------------------------------------------------------

  it('filters observations before start_period', async () => {
    // Observations: 2019, 2020, 2021, 2022; start_period: 2020
    const observations = [
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2019', value: 2.3, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2020', value: 3.5, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2021', value: 5.1, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2022', value: 2.8, status: null },
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2020',
    });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.observations.map((o) => o.time_period)).toEqual(['2020', '2021', '2022']);
  });

  it('filters observations after end_period', async () => {
    const observations = [
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2019', value: 2.3, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2020', value: 3.5, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2021', value: 5.1, status: null },
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      end_period: '2020',
    });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.observations.map((o) => o.time_period)).toEqual(['2019', '2020']);
  });

  it('filters observations to [start_period, end_period] range', async () => {
    const observations = [
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2018', value: 1.0, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2019', value: 2.3, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2020', value: 3.5, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2021', value: 5.1, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2022', value: 2.8, status: null },
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2019',
      end_period: '2021',
    });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.observations.map((o) => o.time_period)).toEqual(['2019', '2020', '2021']);
  });

  it('normalizes upstream YYYY-MNN monthly format against YYYY-MM input', async () => {
    // Upstream emits "1956-M01"; input start_period uses "YYYY-MM" format.
    // Use 3-segment key to match mock structure.
    const observations = [
      { series_key: 'USA.CPI.M', time_period: '1955-M12', value: 10.0, status: null },
      { series_key: 'USA.CPI.M', time_period: '1956-M01', value: 11.0, status: null },
      { series_key: 'USA.CPI.M', time_period: '1956-M06', value: 12.0, status: null },
      { series_key: 'USA.CPI.M', time_period: '1957-M01', value: 13.0, status: null },
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.CPI.M',
      start_period: '1956-01', // YYYY-MM input format
      end_period: '1956-06', // YYYY-MM input format
    });
    const result = await imfQueryDataset.handler(input, ctx);

    // Should include 1956-M01 and 1956-M06, exclude 1955-M12 and 1957-M01
    expect(result.observations.map((o) => o.time_period)).toEqual(['1956-M01', '1956-M06']);
  });

  it('returns all observations when no period filter is set', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.observations).toHaveLength(MOCK_OBSERVATIONS.length);
  });

  // -------------------------------------------------------------------------
  // #11: period input validation (malformed + reversed ranges)
  // -------------------------------------------------------------------------

  it('rejects a malformed start_period before any upstream call', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: 'not-a-period',
    });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_period_format' },
    });
    // Known-bad input is rejected before touching the network.
    expect(mockSvc.findDataflow).not.toHaveBeenCalled();
    expect(mockSvc.fetchData).not.toHaveBeenCalled();
  });

  it('rejects a malformed end_period', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      end_period: 'garbage',
    });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_period_format' },
    });
  });

  it('rejects a reversed range (start_period > end_period)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2024',
      end_period: '2020',
    });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_period_range' },
    });
    // Rejected before the upstream data fetch.
    expect(mockSvc.fetchData).not.toHaveBeenCalled();
  });

  it('accepts a valid forward range and returns the filtered series', async () => {
    const observations = [
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2009', value: 1.0, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2010', value: 2.0, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2015', value: 3.0, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2020', value: 4.0, status: null },
      { series_key: 'USA.NGDP_RPCH.A', time_period: '2021', value: 5.0, status: null },
    ];
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2010',
      end_period: '2020',
    });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.observations.map((o) => o.time_period)).toEqual(['2010', '2015', '2020']);
  });

  // -------------------------------------------------------------------------
  // #5: no_data availability enrichment
  // -------------------------------------------------------------------------

  it('enriches no_data error with "not covered" message when series_count is 0', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    mockSvc.fetchAvailabilityConstraint.mockResolvedValue({
      series_count: 0,
      available_codes: {},
      time_period_start: null,
      time_period_end: null,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'EER', key: 'TUR.REER_IX.M' });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('no_data');
    // Message should communicate zero-series coverage for TUR
    expect(err.message).toContain('0 series');
    expect(err.message).toContain('TUR');
  });

  it('enriches no_data error with available codes when series_count > 0', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    mockSvc.fetchAvailabilityConstraint.mockResolvedValue({
      series_count: 9,
      available_codes: {
        INDICATOR: { count: 2, codes: ['DISR_RT_PT_A_PT', 'MFS135_RT_PT_A_PT'] },
        FREQ: { count: 2, codes: ['A', 'M'] },
      },
      time_period_start: '1964',
      time_period_end: '2026-04',
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'MFS_IR',
      key: 'TUR.MFS135_XDC_RT_PT_A_PT.M',
    });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('no_data');
    // Should mention that series exist but combination is wrong
    expect(err.message).toContain('9 series');
    expect(err.message).toContain('DISR_RT_PT_A_PT');
    // Should mention time range
    expect(err.message).toContain('1964');
    expect(err.data.availability.series_count).toBe(9);
  });

  it('degrades to generic no_data message when availability fetch fails', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    mockSvc.fetchAvailabilityConstraint.mockResolvedValue(null);
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'ZZZ.NGDP_RPCH.A' });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('no_data');
    // Generic message — no availability context
    expect(err.data.availability).toBeUndefined();
    expect(err.message).toContain('No data returned');
  });

  it('formats period range without caveat note', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2020',
      end_period: '2022',
      observations: MOCK_OBSERVATIONS,
      series_attributes: MOCK_SERIES_ATTRS,
      observation_count: 3,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const blocks = imfQueryDataset.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('2020');
    expect(text).toContain('2022');
    // No longer emits the "full available series" caveat
    expect(text).not.toContain('full available series');
    expect(text).not.toContain('may extend beyond');
  });

  // -------------------------------------------------------------------------
  // #21: a bound covers the whole period it names
  // -------------------------------------------------------------------------

  /**
   * Observation sets at each frequency the portal publishes, straddling 2023 on
   * both sides. The FREQUENCY availability constraint reports five codes with
   * data catalog-wide — A, S, Q, M, D — and each emits its own label shape.
   */
  const ANNUAL = ['2022', '2023', '2024'];
  // Semi-annual labels (PIP).
  const SEMIANNUAL = ['2022-S2', '2023-S1', '2023-S2', '2024-S1'];
  const QUARTERLY = ['2022-Q4', '2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4', '2024-Q1'];
  // Monthly labels arrive in the upstream YYYY-MNN form, not the YYYY-MM input form.
  const MONTHLY = ['2022-M12', '2023-M01', '2023-M06', '2023-M12', '2024-M01'];
  // Daily labels (IRFCL, CCI).
  const DAILY = ['2022-12-30', '2023-01-05', '2023-06-15', '2023-12-29', '2024-01-04'];

  /** Run a query over the given period labels and return the labels that survive filtering. */
  const periodsReturned = async (
    timePeriods: string[],
    bounds: { start_period?: string; end_period?: string },
  ): Promise<string[]> => {
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: timePeriods.map((time_period, i) => ({
        series_key: 'USA.NGDP_RPCH.A',
        time_period,
        value: i + 1,
        status: null,
      })),
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      ...bounds,
    });
    const result = await imfQueryDataset.handler(input, ctx);
    return result.observations.map((o) => o.time_period);
  };

  /**
   * Every combination of bound granularity against observation granularity, both
   * directions. The rule under test: a bound expands to the inclusive edge of the
   * period it names, and an observation is kept when its own period overlaps.
   */
  const PERIOD_CASES: Array<{
    name: string;
    data: string[];
    bounds: { start_period?: string; end_period?: string };
    expected: string[];
  }> = [
    // -- end bound coarser than the data: the reported defect ------------------
    {
      name: 'annual end bound keeps every month of the year it names',
      data: MONTHLY,
      bounds: { end_period: '2023' },
      expected: ['2022-M12', '2023-M01', '2023-M06', '2023-M12'],
    },
    {
      name: 'annual end bound keeps every quarter of the year it names',
      data: QUARTERLY,
      bounds: { end_period: '2023' },
      expected: ['2022-Q4', '2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4'],
    },
    {
      name: 'annual end bound against annual data',
      data: ANNUAL,
      bounds: { end_period: '2023' },
      expected: ['2022', '2023'],
    },
    {
      name: 'quarterly end bound keeps every month of the quarter it names',
      data: MONTHLY,
      bounds: { end_period: '2023-Q1' },
      expected: ['2022-M12', '2023-M01'],
    },
    {
      name: 'quarterly bounds reach the quarter’s closing month, not just its first two',
      data: ['2022-M12', '2023-M01', '2023-M03', '2023-M04'],
      bounds: { start_period: '2023-Q1', end_period: '2023-Q1' },
      expected: ['2023-M01', '2023-M03'],
    },
    // -- start bound coarser than the data ------------------------------------
    {
      name: 'annual start bound admits the first month of the year it names',
      data: MONTHLY,
      bounds: { start_period: '2023' },
      expected: ['2023-M01', '2023-M06', '2023-M12', '2024-M01'],
    },
    {
      name: 'annual start bound admits the first quarter of the year it names',
      data: QUARTERLY,
      bounds: { start_period: '2023' },
      expected: ['2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4', '2024-Q1'],
    },
    {
      name: 'annual start bound against annual data',
      data: ANNUAL,
      bounds: { start_period: '2023' },
      expected: ['2023', '2024'],
    },
    {
      name: 'quarterly start bound admits only months from that quarter on',
      data: MONTHLY,
      bounds: { start_period: '2023-Q4' },
      expected: ['2023-M12', '2024-M01'],
    },
    // -- bound finer than the data: overlap, not containment -------------------
    {
      name: 'quarterly end bound keeps the annual observation it falls inside',
      data: ANNUAL,
      bounds: { end_period: '2023-Q1' },
      expected: ['2022', '2023'],
    },
    {
      name: 'quarterly start bound keeps the annual observation it falls inside',
      data: ANNUAL,
      bounds: { start_period: '2023-Q4' },
      expected: ['2023', '2024'],
    },
    {
      name: 'monthly end bound keeps the quarter it falls inside',
      data: QUARTERLY,
      bounds: { end_period: '2023-02' },
      expected: ['2022-Q4', '2023-Q1'],
    },
    {
      name: 'monthly start bound keeps the quarter it falls inside',
      data: QUARTERLY,
      bounds: { start_period: '2023-11' },
      expected: ['2023-Q4', '2024-Q1'],
    },
    // -- equal bounds ---------------------------------------------------------
    {
      name: 'equal annual bounds select the whole year from monthly data',
      data: MONTHLY,
      bounds: { start_period: '2023', end_period: '2023' },
      expected: ['2023-M01', '2023-M06', '2023-M12'],
    },
    {
      name: 'equal annual bounds select the single annual observation',
      data: ANNUAL,
      bounds: { start_period: '2023', end_period: '2023' },
      expected: ['2023'],
    },
    {
      name: 'equal quarterly bounds select the single quarter',
      data: QUARTERLY,
      bounds: { start_period: '2023-Q2', end_period: '2023-Q2' },
      expected: ['2023-Q2'],
    },
    {
      name: 'equal monthly bounds select the single month across input/upstream formats',
      data: MONTHLY,
      bounds: { start_period: '2023-06', end_period: '2023-06' },
      expected: ['2023-M06'],
    },
    // -- both bounds, mixed granularity ---------------------------------------
    {
      name: 'quarterly start with annual end keeps the whole final year',
      data: QUARTERLY,
      bounds: { start_period: '2022-Q1', end_period: '2023' },
      expected: ['2022-Q4', '2023-Q1', '2023-Q2', '2023-Q3', '2023-Q4'],
    },
    {
      name: 'matching monthly bounds behave as before (control)',
      data: MONTHLY,
      bounds: { start_period: '2023-01', end_period: '2023-12' },
      expected: ['2023-M01', '2023-M06', '2023-M12'],
    },
    // -- semi-annual observations (PIP) ---------------------------------------
    {
      name: 'annual bounds select both halves of the year from semi-annual data',
      data: SEMIANNUAL,
      bounds: { start_period: '2023', end_period: '2023' },
      expected: ['2023-S1', '2023-S2'],
    },
    {
      name: 'a semi-annual bound selects the half it names',
      data: SEMIANNUAL,
      bounds: { start_period: '2023-S2', end_period: '2023-S2' },
      expected: ['2023-S2'],
    },
    {
      name: 'a quarterly bound keeps the half-year it falls inside',
      data: SEMIANNUAL,
      bounds: { start_period: '2023-Q3', end_period: '2023-Q3' },
      expected: ['2023-S2'],
    },
    {
      name: 'a semi-annual bound against monthly data covers its six months',
      data: MONTHLY,
      bounds: { start_period: '2023-S1', end_period: '2023-S1' },
      expected: ['2023-M01', '2023-M06'],
    },
    // -- daily observations (IRFCL, CCI) --------------------------------------
    {
      name: 'annual bounds select every day of the year from daily data',
      data: DAILY,
      bounds: { start_period: '2023', end_period: '2023' },
      expected: ['2023-01-05', '2023-06-15', '2023-12-29'],
    },
    {
      name: 'a monthly bound selects only that month of daily data',
      data: DAILY,
      bounds: { start_period: '2023-06', end_period: '2023-06' },
      expected: ['2023-06-15'],
    },
    {
      name: 'a daily bound discriminates within a month, not just to the month',
      data: DAILY,
      bounds: { start_period: '2023-01-06' },
      expected: ['2023-06-15', '2023-12-29', '2024-01-04'],
    },
    {
      name: 'a daily end bound is inclusive of the day it names',
      data: DAILY,
      bounds: { end_period: '2023-01-05' },
      expected: ['2022-12-30', '2023-01-05'],
    },
    {
      name: 'a daily start bound is inclusive of the day it names',
      data: DAILY,
      bounds: { start_period: '2023-06-15' },
      expected: ['2023-06-15', '2023-12-29', '2024-01-04'],
    },
    {
      name: 'a daily bound keeps the month it falls inside',
      data: MONTHLY,
      bounds: { start_period: '2023-06-15', end_period: '2023-06-15' },
      expected: ['2023-M06'],
    },
  ];

  for (const { name, data, bounds, expected } of PERIOD_CASES) {
    it(`#21 ${name}`, async () => {
      await expect(periodsReturned(data, bounds)).resolves.toEqual(expected);
    });
  }

  it('#21 accepts a forward range whose bounds differ in granularity', async () => {
    // "2023-Q2" sorts after "2023" as a string, but Q2 2023 starts inside 2023 —
    // the range is forward and must not be rejected as reversed.
    await expect(
      periodsReturned(QUARTERLY, { start_period: '2023-Q2', end_period: '2023' }),
    ).resolves.toEqual(['2023-Q2', '2023-Q3', '2023-Q4']);
  });

  it('#21 still rejects a genuinely reversed range at mixed granularity', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2024-Q1',
      end_period: '2023',
    });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_period_range' },
    });
  });

  it('#21 rejects an out-of-range month, quarter, half, or day as a format error', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    for (const start_period of [
      '2023-13',
      '2023-00',
      '2023-Q5',
      '2023-Q0',
      '2023-S0',
      '2023-S3',
      '2023-06-32',
      '2023-06-00',
      '2023-13-01',
    ]) {
      const input = imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        start_period,
      });
      await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_period_format' },
      });
    }
  });

  it('#21 accepts every label shape the portal emits as a bound, so time_period round-trips', async () => {
    // Each of these is a label some dataflow returns in time_period; a caller
    // that feeds one back as a bound must not be told it is malformed.
    for (const start_period of [
      '2023',
      '2023-S1',
      '2023-Q1',
      '2023-01',
      '2023-M01',
      '2023-01-05',
    ]) {
      await expect(periodsReturned(['2023'], { start_period })).resolves.toEqual(['2023']);
    }
  });

  it('#21 keeps observation labels it cannot parse rather than filtering them out', async () => {
    // A shape the portal does not emit today. Dropping the row would lose data
    // over a label the parser simply does not know.
    await expect(
      periodsReturned(['2023-W07', '2023-M06', '2024-M01'], { end_period: '2023' }),
    ).resolves.toEqual(['2023-W07', '2023-M06']);
  });

  /** Run the full tool envelope over the given labels, as a client receives it. */
  const contractWith = async (timePeriods: string[], bounds: Record<string, string>) => {
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: timePeriods.map((time_period) => ({
        series_key: 'USA.NGDP_RPCH.A',
        time_period,
        value: 1,
        status: null,
      })),
    });
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      ...bounds,
    });
    return {
      notice: (result.structuredContent as Record<string, unknown>).notice as string | undefined,
      text: (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n'),
    };
  };

  it('#21 discloses that an unparsed label was returned outside the requested range', async () => {
    const { notice, text } = await contractWith(['2023-W07', '2023-M06'], { end_period: '2023' });

    // Silence here is what let a coarse bound quietly drop a year — the caller
    // must be able to see the range did not apply to these rows.
    expect(notice).toContain('2023-W07');
    expect(notice).toContain('1 observation(s)');
    expect(notice).toContain('unfiltered');
    // And it has to reach content[], not only structuredContent.
    expect(text).toContain('2023-W07');
  });

  it('#21 stays quiet when every label parsed', async () => {
    const { notice } = await contractWith(MONTHLY, { end_period: '2023' });
    expect(notice).toBeUndefined();
  });

  it('#21 stays quiet about unparsed labels when no bound was requested', async () => {
    // Nothing was filtered, so there is no unapplied range to disclose.
    const { notice } = await contractWith(['2023-W07', '2023-M06'], {});
    expect(notice).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // #22: a range that empties a non-empty response is not a coverage failure
  // -------------------------------------------------------------------------

  const CPI_OBSERVATIONS = [
    { series_key: 'USA.CPI.M', time_period: '1950-M01', value: 24.1, status: null },
    { series_key: 'USA.CPI.M', time_period: '2023-M06', value: 304.0, status: null },
    { series_key: 'USA.CPI.M', time_period: '2026-M06', value: 330.2, status: null },
  ];

  it('#22 reports no_data_in_range when the requested range excludes every observation', async () => {
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: CPI_OBSERVATIONS,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'CPI',
      key: 'USA.CPI.M',
      start_period: '1800',
      end_period: '1801',
    });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data.reason).toBe('no_data_in_range');
    // The message names the requested range, the range the data occupies, and how much was excluded.
    expect(err.message).toContain('1800 – 1801');
    expect(err.message).toContain('1950-M01 – 2026-M06');
    expect(err.message).toContain('3 observation(s)');
    expect(err.data.available_range).toEqual({ first: '1950-M01', last: '2026-M06' });
    expect(err.data.excluded_observation_count).toBe(3);
  });

  it('#22 points recovery at the period bounds, not at the key', async () => {
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: CPI_OBSERVATIONS,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'CPI',
      key: 'USA.CPI.M',
      start_period: '1800',
      end_period: '1801',
    });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.data.recovery.hint).toContain('start_period');
    expect(err.data.recovery.hint).toContain('end_period');
    expect(err.data.recovery.hint).toContain('valid');
    // No availability enrichment — it would list the caller's own codes as the
    // ones that do have data and send them to change the key.
    expect(err.data.availability).toBeUndefined();
  });

  it('#22 does not spend an availability lookup on a range failure', async () => {
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: CPI_OBSERVATIONS,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'CPI',
      key: 'USA.CPI.M',
      start_period: '1800',
      end_period: '1801',
    });

    await imfQueryDataset.handler(input, ctx).catch(() => undefined);
    expect(mockSvc.fetchAvailabilityConstraint).not.toHaveBeenCalled();
  });

  it('#22 keeps reporting no_data when upstream itself returned nothing', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    mockSvc.fetchAvailabilityConstraint.mockResolvedValue({
      series_count: 150,
      available_codes: { FREQUENCY: { count: 3, codes: ['A', 'M', 'Q'] } },
      time_period_start: '1950-01-01',
      time_period_end: '2026-07-01',
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'CPI',
      key: 'USA.ZZZ.M',
      start_period: '2020',
      end_period: '2024',
    });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('no_data');
    expect(err.data.availability.series_count).toBe(150);
  });

  it('#22 reports no_data, not no_data_in_range, when every row was null padding', async () => {
    // Padding removal happens before the range check; nothing real survived it,
    // so this is a coverage question and #7's fallthrough must still hold.
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: [
        { series_key: 'FRA.CPI.M', time_period: '1900-M01', value: null, status: null },
        { series_key: 'FRA.CPI.M', time_period: '1900-M02', value: null, status: null },
      ],
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'FRA.CPI.M',
      start_period: '2020',
    });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('no_data');
  });

  it('#22 declares no_data_in_range in the error contract', () => {
    const entry = imfQueryDataset.errors?.find((e) => e.reason === 'no_data_in_range');
    expect(entry?.code).toBe(JsonRpcErrorCode.NotFound);
    expect(entry?.recovery).toContain('start_period');
  });

  // -------------------------------------------------------------------------
  // #23: empty key segments are rejected; * is the wildcard
  // -------------------------------------------------------------------------

  it('#23 rejects an empty key segment before the data fetch and names * in the message', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: '.NGDP_RPCH.A' });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data.reason).toBe('empty_key_segment');
    expect(err.message).toContain('*');
    // Names the position and the dimension sitting there.
    expect(err.message).toContain('position 1 (COUNTRY)');
    expect(err.data.emptyPositions).toEqual([1]);
    // Never sent upstream to come back as a misdiagnosed no_data.
    expect(mockSvc.fetchData).not.toHaveBeenCalled();
    expect(mockSvc.fetchAvailabilityConstraint).not.toHaveBeenCalled();
  });

  it('#23 rejects an interior empty segment and reports every blank position', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: '..A' });

    const err = await imfQueryDataset.handler(input, ctx).catch((e) => e);
    expect(err.data.reason).toBe('empty_key_segment');
    expect(err.data.emptyPositions).toEqual([1, 2]);
    expect(err.data.keyFormat).toBe('COUNTRY.INDICATOR.FREQUENCY');
  });

  it('#23 treats a whitespace-only segment as empty', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA. .A' });

    await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'empty_key_segment' },
    });
  });

  it('#23 passes a * wildcard through to the data fetch unchanged', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: '*.NGDP_RPCH.A',
      start_period: '1990',
      end_period: '2024',
    });

    const result = await imfQueryDataset.handler(input, ctx);
    expect(mockSvc.fetchData).toHaveBeenCalledWith(
      'IMF.RES',
      'WEO',
      '9.0.0',
      '*.NGDP_RPCH.A',
      '1990',
      '2024',
      expect.anything(),
      expect.anything(),
    );
    expect(result.key).toBe('*.NGDP_RPCH.A');
  });

  it('#23 documents the * wildcard on the key parameter and the tool description', () => {
    const keyDescription = imfQueryDataset.input.shape.key.description ?? '';
    expect(keyDescription).toContain('*');
    expect(keyDescription).toMatch(/\*\.NGDP_RPCH\.A/);
    expect(imfQueryDataset.description).toContain('*');
  });

  it('#23 declares empty_key_segment in the error contract', () => {
    const entry = imfQueryDataset.errors?.find((e) => e.reason === 'empty_key_segment');
    expect(entry?.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(entry?.recovery).toContain('*');
  });

  // -------------------------------------------------------------------------
  // #26: the availability code cap is disclosed, never presented as the set
  // -------------------------------------------------------------------------

  const noDataWith = async (
    available_codes: Record<string, { codes: string[]; count: number }>,
  ) => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    mockSvc.fetchAvailabilityConstraint.mockResolvedValue({
      series_count: 8200,
      available_codes,
      time_period_start: '1980-01-01',
      time_period_end: '2032-01-01',
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.ZZZ.A' });
    return (await imfQueryDataset.handler(input, ctx).catch((e) => e)) as {
      message: string;
      data: { recovery: { hint: string } };
    };
  };

  it('#26 states how many of how many a capped dimension shows, and still names the codes', async () => {
    const err = await noDataWith({
      COUNTRY: { count: 210, codes: ['ABW', 'AFG', 'AGO'] },
      FREQUENCY: { count: 1, codes: ['A'] },
    });

    expect(err.message).toContain('COUNTRY: 3 of 210 codes with data shown (ABW, AFG, AGO)');
    // The codes are the point — suppressing them leaves nothing to correct against.
    expect(err.message).toContain('ABW');
  });

  it('#26 lists a dimension inside the cap plain, so it reads as complete', async () => {
    const err = await noDataWith({
      FREQUENCY: { count: 3, codes: ['A', 'M', 'Q'] },
      INDICATOR: { count: 46, codes: ['BCA', 'BCA_NGDPD'] },
    });

    // No "of" annotation when codes.length === count — the list is the set.
    expect(err.message).toContain('FREQUENCY: A, M, Q');
    expect(err.message).not.toMatch(/FREQUENCY: \d+ of/);
    expect(err.message).toContain('INDICATOR: 2 of 46 codes with data shown (BCA, BCA_NGDPD)');
  });

  it('#26 carries the same cap disclosure into the recovery hint', async () => {
    const err = await noDataWith({
      COUNTRY: { count: 210, codes: ['ABW', 'AFG'] },
      FREQUENCY: { count: 1, codes: ['A'] },
    });

    expect(err.data.recovery.hint).toContain('COUNTRY: 2 of 210 codes with data shown');
    expect(err.data.recovery.hint).toContain('FREQUENCY: A');
  });

  // -------------------------------------------------------------------------
  // #24: dataflow-list failures are declared and not relabeled
  // -------------------------------------------------------------------------

  it('#24 declares dataflow_list_unavailable alongside structure_unavailable', () => {
    const entry = imfQueryDataset.errors?.find((e) => e.reason === 'dataflow_list_unavailable');
    expect(entry?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(entry?.retryable).toBe(true);
  });

  it('#24 keeps the dataflow_list_unavailable reason instead of relabeling it structure_unavailable', async () => {
    mockSvc.findDataflow.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });

    const err = (await imfQueryDataset.handler(input, ctx).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e,
    )) as McpError;

    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain('/structure/');
  });
});
