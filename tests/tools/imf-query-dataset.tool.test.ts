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
      available_codes: { INDICATOR: ['DISR_RT_PT_A_PT', 'MFS135_RT_PT_A_PT'], FREQ: ['A', 'M'] },
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
});
