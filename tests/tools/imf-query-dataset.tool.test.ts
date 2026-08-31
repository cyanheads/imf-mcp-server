/**
 * @fileoverview Tests for the imf_query_dataset tool — inline, canvas spillover,
 * period-range filtering, series attributes across both output channels, and
 * error paths. The period cases assert the periods a
 * caller gets back rather than the shape of any internal comparison, since the
 * defect they guard (#21) was a correct-looking comparison applied to the wrong
 * representation. The attribute cases (#3, #15, #18) work the same way: they read
 * the rendered Series cells and the per-series entries a caller receives, because
 * a line that is simply missing satisfies "the sentinel is not printed" without
 * carrying anything across.
 * @module tests/tools/imf-query-dataset.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMcpError, recoveryHint } from '../helpers/errors.js';

vi.mock('@/services/imf-sdmx/imf-sdmx-service.js', () => ({
  getImfSdmxService: vi.fn(),
}));

vi.mock('@/services/canvas/canvas-accessor.js', () => ({
  getCanvas: vi.fn(),
}));

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
  { series_key: 'USA.NGDP_RPCH.A', time_period: '2020', value: 3.5, status: null },
  { series_key: 'USA.NGDP_RPCH.A', time_period: '2021', value: 5.1, status: 'E' },
  { series_key: 'USA.NGDP_RPCH.A', time_period: '2022', value: 2.8, status: null },
];

const MOCK_SERIES_ATTRS = { unit: 'Percent', scale: null, decimals: 3 };

const MOCK_QUERY_RESULT = {
  dataflowId: 'WEO',
  key: 'USA.NGDP_RPCH.A',
  observations: MOCK_OBSERVATIONS,
  seriesAttributes: MOCK_SERIES_ATTRS,
  seriesAttributesByKey: { 'USA.NGDP_RPCH.A': MOCK_SERIES_ATTRS },
};

/**
 * Two series whose attributes differ on every axis a per-series lookup has to
 * keep apart: an aggregate scaled by 10^9 with a coded unit, against one with the
 * `"0"` no-scale sentinel and no unit at all. A fixture where both share a scale
 * cannot tell a per-series lookup from a global one, and one where both carry a
 * unit cannot tell the rendered `—` from a value.
 */
const NGDPD_ATTRS = { unit: 'US Dollar', scale: '9', decimals: 3 };
const NGDP_RPCH_ATTRS = { unit: null, scale: '0', decimals: 3 };

const TWO_SERIES_RESULT = {
  dataflowId: 'WEO',
  key: 'USA.NGDP_RPCH+NGDPD.A',
  observations: [
    { series_key: 'USA.NGDPD.A', time_period: '2020', value: 21_375_275_000_000, status: null },
    { series_key: 'USA.NGDP_RPCH.A', time_period: '2020', value: -2.081277, status: null },
    { series_key: 'USA.NGDPD.A', time_period: '2021', value: 23_725_650_000_000, status: null },
    { series_key: 'USA.NGDP_RPCH.A', time_period: '2021', value: 6.151865, status: null },
  ],
  // Decoded last, so a last-write-wins global would report scale "0" for both.
  seriesAttributes: NGDPD_ATTRS,
  seriesAttributesByKey: {
    'USA.NGDPD.A': NGDPD_ATTRS,
    'USA.NGDP_RPCH.A': NGDP_RPCH_ATTRS,
  },
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
    expect(result.observations[0]).toEqual({
      series_key: 'USA.NGDP_RPCH.A',
      time_period: '2020',
      value: 3.5,
      status: null,
    });
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

  it('#45 preserves the data fetch McpError code, reason, and cause', async () => {
    const cause = new Error('socket timed out');
    const dataError = new McpError(
      JsonRpcErrorCode.Timeout,
      'IMF data request timed out',
      {
        reason: 'upstream_timeout',
        retryable: true,
        recovery: { hint: 'Retry the data request.' },
      },
      { cause },
    );
    mockSvc.fetchData.mockRejectedValue(dataError);
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });

    const error = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(error).toBe(dataError);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'upstream_timeout', retryable: true });
    expect(error.cause).toBe(cause);
  });

  it('#45 preserves the data fetch McpError contract in both MCP result channels', async () => {
    mockSvc.fetchData.mockRejectedValue(
      new McpError(JsonRpcErrorCode.Timeout, 'IMF data request timed out', {
        reason: 'upstream_timeout',
        retryable: true,
        recovery: { hint: 'Retry the data request.' },
      }),
    );

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
    });
    const error = (
      result.structuredContent as {
        error: { code: number; message: string; data: Record<string, unknown> };
      }
    ).error;
    const text = (result.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: 'IMF data request timed out',
      data: { reason: 'upstream_timeout', retryable: true },
    });
    expect((error.data.recovery as { hint: string }).hint).toBe('Retry the data request.');
    expect(text).toContain('IMF data request timed out');
    expect(text).toContain('Retry the data request.');
  });

  it('stages an over-budget automatic result with a budget-limited preview', async () => {
    const observations = Array.from({ length: 1_500 }, (_, index) => ({
      series_key: 'USA.NGDP_RPCH.A',
      time_period: `PERIOD_WITH_A_LONG_LABEL_${String(index).padStart(4, '0')}`,
      value: index + 0.123456,
      status: null,
    }));
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'ignored-by-explicit-registration',
      rowCount: observations.length,
      columns: [],
    });
    const mockInstance = { canvasId: 'canvas-abc', registerTable };
    const mockCanvasSvc = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(mockCanvasSvc);

    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.truncated).toBe(true);
    expect(result.canvas_id).toBe('canvas-abc');
    expect(result.table_name).toMatch(/^imf_[0-9a-f]{8}$/);
    expect(result.observation_count).toBe(observations.length);
    expect(result.observations.length).toBeLessThan(observations.length);
    expect(registerTable).toHaveBeenCalledOnce();
    expect(result.source).toBe(
      'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    );
  });

  it('returns an under-budget automatic result inline without acquiring a canvas', async () => {
    const mockInstance = { canvasId: 'canvas-xyz', registerTable: vi.fn() };
    const mockCanvasSvc = { acquire: vi.fn().mockResolvedValue(mockInstance) };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(mockCanvasSvc);

    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.truncated).toBe(false);
    expect(result.canvas_id).toBeUndefined();
    expect(result.observations).toHaveLength(3);
    expect(mockCanvasSvc.acquire).not.toHaveBeenCalled();
  });

  it('#39 explicitly stages an under-budget result on a fresh canvas without calling it truncated', async () => {
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'imf_fresh',
      rowCount: MOCK_OBSERVATIONS.length,
      columns: [],
    });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'canvas-fresh', registerTable });
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({ acquire });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      output_mode: 'canvas',
    });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(acquire).toHaveBeenCalledWith(undefined, expect.anything());
    expect(registerTable).toHaveBeenCalledOnce();
    expect(structured).toMatchObject({
      staged: true,
      truncated: false,
      canvas_id: 'canvas-fresh',
      observation_count: 3,
    });
    expect(structured.table_name).toMatch(/^imf_[0-9a-f]{8}$/);
    expect(structured.observations).toHaveLength(3);
  });

  it('#39 explicitly stages into an existing canvas, while canvas_id alone keeps auto behavior', async () => {
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'imf_existing',
      rowCount: MOCK_OBSERVATIONS.length,
      columns: [],
    });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'canvas-existing', registerTable });
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({ acquire });

    const staged = await imfQueryDataset.handler(
      imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        canvas_id: 'canvas-existing',
        output_mode: 'canvas',
      }),
      createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
    );
    const automatic = await imfQueryDataset.handler(
      imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        canvas_id: 'canvas-existing',
      }),
      createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
    );

    expect(acquire).toHaveBeenCalledWith('canvas-existing', expect.anything());
    expect(staged).toMatchObject({ staged: true, truncated: false });
    expect(automatic).toMatchObject({ staged: false, truncated: false });
  });

  it('#39 returns canvas_unavailable recovery for explicit staging when DataCanvas is disabled', async () => {
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      output_mode: 'canvas',
    });
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;

    expect(error.code).toBe(JsonRpcErrorCode.ConfigurationError);
    expect(error.data).toMatchObject({ reason: 'canvas_unavailable' });
    expect((error.data.recovery as { hint: string }).hint).toContain('CANVAS_PROVIDER_TYPE=duckdb');
  });

  it('#39 keeps no_data semantics for an empty explicit staging request', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    const registerTable = vi.fn();
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-empty', registerTable }),
    });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      output_mode: 'canvas',
    });
    const error = (result.structuredContent as { error: { data: Record<string, unknown> } }).error;

    expect(error.data).toMatchObject({ reason: 'no_data' });
    expect(registerTable).not.toHaveBeenCalled();
  });

  it('#41 puts describe-before-query guidance in both result channels and composes period caveats', async () => {
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: [
        ...MOCK_OBSERVATIONS,
        { series_key: 'USA.NGDP_RPCH.A', time_period: '2023-W07', value: 1, status: null },
      ],
    });
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'imf_guidance',
      rowCount: 4,
      columns: [],
    });
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-guidance', registerTable }),
    });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      end_period: '2023',
      output_mode: 'canvas',
    });
    const structured = result.structuredContent as {
      notice: string;
      retrieval_guidance: string;
    };
    const text = (result.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    for (const channel of [`${structured.retrieval_guidance} ${structured.notice}`, text]) {
      expect(channel).toContain('imf_dataframe_describe');
      expect(channel).toContain('imf_dataframe_query');
      expect(channel.indexOf('imf_dataframe_describe')).toBeLessThan(
        channel.indexOf('imf_dataframe_query'),
      );
      expect(channel).toContain('2023-W07');
      expect(channel).toContain('unfiltered');
    }
  });

  it('#48 keeps an under-budget automatic result inline instead of staging on a row-size proxy', async () => {
    const observations = Array.from({ length: 350 }, (_, index) => ({
      series_key: 'USA.NGDP_RPCH.A',
      time_period: `P${String(index).padStart(4, '0')}`,
      value: index + 0.123456,
      status: null,
    }));
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
    const acquire = vi.fn().mockResolvedValue({ canvasId: 'canvas-proxy' });
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({ acquire });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
    });
    const structured = result.structuredContent as { staged: boolean };

    expect(JSON.stringify(result).length).toBeLessThanOrEqual(100_000);
    expect(structured.staged).toBe(false);
    expect(acquire).not.toHaveBeenCalled();
  });

  it('#48 budgets the serialized whole staged MCP result without dropping series metadata', async () => {
    const series = Array.from(
      { length: 210 },
      (_, index) => `C${String(index).padStart(3, '0')}.INDICATOR_WITH_A_LONG_IDENTIFIER.A`,
    );
    const observations = Array.from({ length: 800 }, (_, index) => ({
      series_key: series[index % series.length]!,
      time_period: `${1950 + (index % 74)}`,
      value: index + 0.123456,
      status: null,
    })).concat({
      series_key: series[0]!,
      time_period: '2023-W07',
      value: 999.123456,
      status: null,
    });
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations,
      seriesAttributesByKey: Object.fromEntries(series.map((key) => [key, NGDPD_ATTRS])),
    });
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'imf_budget',
      rowCount: observations.length,
      columns: [],
    });
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-budget', registerTable }),
    });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: '*.INDICATOR_WITH_A_LONG_IDENTIFIER.A',
      end_period: '2023',
    });
    const structured = result.structuredContent as {
      notice: string;
      observation_count: number;
      observations: unknown[];
      retrieval_guidance: string;
      series_metadata: unknown[];
      staged: boolean;
      truncated: boolean;
    };
    const text = (result.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    const serializedChars = JSON.stringify(result).length;
    expect(serializedChars).toBeGreaterThan(99_000);
    expect(serializedChars).toBeLessThanOrEqual(100_000);
    expect(structured).toMatchObject({ observation_count: 801, staged: true, truncated: true });
    expect(structured.observations.length).toBeLessThan(801);
    expect(structured.series_metadata).toHaveLength(210);
    expect(structured.retrieval_guidance).toContain('imf_dataframe_describe');
    expect(structured.notice).toContain('2023-W07');
    expect(text).toContain(structured.retrieval_guidance);
    expect(text).toContain(structured.notice);
  });

  it('#48 returns an actionable error when fixed staged metadata alone exceeds the budget', async () => {
    const series = Array.from(
      { length: 1_200 },
      (_, index) => `C${String(index).padStart(4, '0')}.${'LONG_INDICATOR_'.repeat(8)}.A`,
    );
    const observations = series.map((series_key, index) => ({
      series_key,
      time_period: '2023',
      value: index,
      status: null,
    }));
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations,
      seriesAttributesByKey: Object.fromEntries(series.map((key) => [key, NGDPD_ATTRS])),
    });
    const registerTable = vi.fn();
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-too-large', registerTable }),
    });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: '*.NGDPD.A',
      output_mode: 'canvas',
    });
    const error = (
      result.structuredContent as { error: { code: number; data: Record<string, unknown> } }
    ).error;
    const text = (result.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data).toMatchObject({ reason: 'response_too_large' });
    expect((error.data.recovery as { hint: string }).hint).toContain('Narrow the dimension key');
    expect(text).toContain("The staged result's full series metadata");
    expect(text).toContain('Narrow the dimension key');
    expect(registerTable).not.toHaveBeenCalled();
  });

  it('formats inline observations as markdown table', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: MOCK_SERIES_ATTRS,
      observation_count: 3,
      staged: false,
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

  /**
   * Attribute cells a reader sees on the Series line, split out of the rendered
   * text. Asserting on the cells rather than on substrings is what separates "the
   * sentinel is not printed as a bare 0" (#3's actual goal) from "the line is
   * missing" — the second passes for free by dropping the attributes entirely,
   * which is the defect #18 reported.
   */
  const seriesLineCells = (text: string): string[] => {
    const line = text.split('\n').find((l) => l.startsWith('**Series:**'));
    if (!line) return [];
    return line
      .replace('**Series:**', '')
      .split('|')
      .map((cell) => cell.trim());
  };

  it('#3 never renders the "0" scale sentinel as a bare value', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: { unit: null, scale: '0', decimals: 0 },
      observation_count: 3,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const cells = seriesLineCells((imfQueryDataset.format!(output)[0] as { text: string }).text);

    // A reader must never meet a lone "0" standing in for the absent scale.
    expect(cells).not.toContain('0');
    // It is named instead of dropped, so the attribute still crosses the channel.
    expect(cells).toContain('no scale multiplier');
  });

  it('#18 carries decimals into content[] even when scale is the "0" sentinel', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: { unit: null, scale: '0', decimals: 0 },
      observation_count: 3,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const cells = seriesLineCells((imfQueryDataset.format!(output)[0] as { text: string }).text);

    // Gating the whole line on a meaningful scale is what dropped decimals.
    expect(cells).toContain('0 decimals');
  });

  it('#3 shows unit and decimals with scale "0" named, not printed raw', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: { unit: 'Percent', scale: '0', decimals: 2 },
      observation_count: 3,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const cells = seriesLineCells((imfQueryDataset.format!(output)[0] as { text: string }).text);

    expect(cells).toContain('Percent');
    expect(cells).toContain('2 decimals');
    expect(cells).not.toContain('0');
  });

  it('renders a real scale code as-is', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDPD.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: { unit: 'US Dollar', scale: '9', decimals: 3 },
      observation_count: 3,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const cells = seriesLineCells((imfQueryDataset.format!(output)[0] as { text: string }).text);

    expect(cells).toEqual(expect.arrayContaining(['US Dollar', '9', '3 decimals']));
  });

  it('omits the Series line only when the series carries no attributes at all', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: MOCK_OBSERVATIONS,
      series_attributes: { unit: null, scale: null, decimals: null },
      observation_count: 3,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
    };
    const text = (imfQueryDataset.format!(output)[0] as { text: string }).text;

    expect(text).not.toContain('**Series:**');
  });

  it('formats canvas spill path with canvas_id and table_name', () => {
    const output = {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      observations: [],
      series_attributes: MOCK_SERIES_ATTRS,
      observation_count: 5000,
      staged: true,
      truncated: true,
      canvas_id: 'canvas-abc',
      table_name: 'spilled_abc123',
      retrieval_guidance:
        'Call imf_dataframe_describe first, then imf_dataframe_query against the staged table.',
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
    expect(result.observations[0]!.time_period).toBe('1955-M01');
    expect(result.observations[0]!.value).toBe(42.3);
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

  /**
   * The availability endpoint answers two different questions depending on
   * whether a code is pinned, and the handler asks both. Mocking by scope is what
   * keeps a test honest about which answer it is exercising — a single mock
   * returning one object for both calls describes a response the API never gives.
   */
  const availability = (
    seriesCount: number,
    availableCodes: Record<string, { codes: string[]; count: number }> = {},
    time: { start: string | null; end: string | null } = { start: null, end: null },
  ) => ({
    series_count: seriesCount,
    available_codes: availableCodes,
    time_period_start: time.start,
    time_period_end: time.end,
  });

  type Availability = ReturnType<typeof availability>;

  /** Serve one availability response for the key-scoped probe and another for the dataflow-wide one. */
  const availabilityByScope = (
    keyed: Availability | null,
    dataflowWide: Availability | null = null,
  ) => {
    mockSvc.fetchAvailabilityConstraint.mockImplementation((_flow: string, code: string) =>
      Promise.resolve(code === '' ? dataflowWide : keyed),
    );
  };

  it('enriches no_data error with "not covered" message when series_count is 0', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    // EER holds 732 series; TUR is simply not one of the countries covered.
    availabilityByScope(
      availability(0),
      availability(732, { COUNTRY: { count: 2, codes: ['USA', 'GBR'] } }),
    );
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'EER', key: 'TUR.REER_IX.M' });

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.data?.reason).toBe('no_data');
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

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.data?.reason).toBe('no_data');
    // Should mention that series exist but combination is wrong
    expect(err.message).toContain('9 series');
    expect(err.message).toContain('DISR_RT_PT_A_PT');
    // Should mention time range
    expect(err.message).toContain('1964');
    expect(err.data?.availability).toMatchObject({ series_count: 9 });
  });

  it('degrades to generic no_data message when availability fetch fails', async () => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    mockSvc.fetchAvailabilityConstraint.mockResolvedValue(null);
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'ZZZ.NGDP_RPCH.A' });

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.data?.reason).toBe('no_data');
    // Generic message — no availability context
    expect(err.data?.availability).toBeUndefined();
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
      staged: false,
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

  it('#35 rejects calendar-invalid daily bounds before every upstream call', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    for (const start_period of ['2023-02-29', '2023-02-30', '2023-04-31', '2023-11-31']) {
      const input = imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        start_period,
      });
      await expect(imfQueryDataset.handler(input, ctx)).rejects.toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        data: { reason: 'invalid_period_format', field: 'start_period', value: start_period },
      });
    }

    expect(mockSvc.findDataflow).not.toHaveBeenCalled();
    expect(mockSvc.fetchDataflowStructure).not.toHaveBeenCalled();
    expect(mockSvc.fetchData).not.toHaveBeenCalled();
  });

  it('#35 accepts a valid leap day and preserves non-daily period controls', async () => {
    for (const start_period of ['2024-02-29', '2024', '2024-S1', '2024-Q1', '2024-02']) {
      await expect(periodsReturned(['2024'], { start_period })).resolves.toEqual(['2024']);
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

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.NotFound);
    expect(err.data?.reason).toBe('no_data_in_range');
    // The message names the requested range, the range the data occupies, and how much was excluded.
    expect(err.message).toContain('1800 – 1801');
    expect(err.message).toContain('1950-M01 – 2026-M06');
    expect(err.message).toContain('3 observation(s)');
    expect(err.data?.available_range).toEqual({ first: '1950-M01', last: '2026-M06' });
    expect(err.data?.excluded_observation_count).toBe(3);
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

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(recoveryHint(err)).toContain('start_period');
    expect(recoveryHint(err)).toContain('end_period');
    expect(recoveryHint(err)).toContain('valid');
    // No availability enrichment — it would list the caller's own codes as the
    // ones that do have data and send them to change the key.
    expect(err.data?.availability).toBeUndefined();
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

    try {
      await imfQueryDataset.handler(input, ctx);
    } catch {
      // The throw is expected; this test asserts the availability lookup was skipped.
    }
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

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.data?.reason).toBe('no_data');
    expect(err.data?.availability).toMatchObject({ series_count: 150 });
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

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.data?.reason).toBe('no_data');
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

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(err.data?.reason).toBe('empty_key_segment');
    expect(err.message).toContain('*');
    // Names the position and the dimension sitting there.
    expect(err.message).toContain('position 1 (COUNTRY)');
    expect(err.data?.emptyPositions).toEqual([1]);
    // Never sent upstream to come back as a misdiagnosed no_data.
    expect(mockSvc.fetchData).not.toHaveBeenCalled();
    expect(mockSvc.fetchAvailabilityConstraint).not.toHaveBeenCalled();
  });

  it('#23 rejects an interior empty segment and reports every blank position', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: '..A' });

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));
    expect(err.data?.reason).toBe('empty_key_segment');
    expect(err.data?.emptyPositions).toEqual([1, 2]);
    expect(err.data?.keyFormat).toBe('COUNTRY.INDICATOR.FREQUENCY');
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

  it('#35 advertises calendar validity in the public daily-period contract and recovery', () => {
    const startDescription = imfQueryDataset.input.shape.start_period.description ?? '';
    const recovery = imfQueryDataset.errors?.find(
      (entry) => entry.reason === 'invalid_period_format',
    )?.recovery;

    expect(startDescription).toContain('calendar-valid YYYY-MM-DD');
    expect(recovery).toContain('calendar-valid YYYY-MM-DD');
  });

  it('#41 advertises describe-before-query in the tool-level staged-result workflow', () => {
    const description = imfQueryDataset.description;

    expect(description).toContain('imf_dataframe_describe');
    expect(description).toContain('imf_dataframe_query');
    expect(description.indexOf('imf_dataframe_describe')).toBeLessThan(
      description.indexOf('imf_dataframe_query'),
    );
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
    return captureMcpError(() => imfQueryDataset.handler(input, ctx));
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

    expect(recoveryHint(err)).toContain('COUNTRY: 2 of 210 codes with data shown');
    expect(recoveryHint(err)).toContain('FREQUENCY: A');
  });

  // -------------------------------------------------------------------------
  // #24: dataflow-list failures are declared and not relabeled
  // -------------------------------------------------------------------------

  it('#24 declares dataflow_list_unavailable alongside structure_unavailable', () => {
    const entry = imfQueryDataset.errors?.find((e) => e.reason === 'dataflow_list_unavailable');
    expect(entry?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(entry?.retryable).toBe(true);
  });

  // -------------------------------------------------------------------------
  // #15: a query resolving to several series keeps each one's own attributes
  // -------------------------------------------------------------------------

  /** Run the two-series WEO query and hand back the tool result. */
  const twoSeriesResult = async () => {
    mockSvc.fetchData.mockResolvedValue(TWO_SERIES_RESULT);
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH+NGDPD.A',
    });
    return imfQueryDataset.handler(input, ctx);
  };

  it('#15 gives each series in a + query its own scale', async () => {
    const result = await twoSeriesResult();

    const byKey = Object.fromEntries(
      (result.series_metadata ?? []).map((series) => [series.series_key, series]),
    );
    expect(byKey['USA.NGDPD.A']?.scale).toBe('9');
    expect(byKey['USA.NGDP_RPCH.A']?.scale).toBe('0');
    // One series carries a unit, the other none — neither may be spread to both.
    expect(byKey['USA.NGDPD.A']?.unit).toBe('US Dollar');
    expect(byKey['USA.NGDP_RPCH.A']?.unit).toBeNull();
  });

  it('#33 carries a per-series unit into series_metadata and the rendered table', async () => {
    // Every series in a dimension-group flow has a unit, and series sharing a
    // key can still disagree on it: on WEO the dollar level is USD and the
    // growth rate PT. Both channels have to say so per row, since a client sees
    // only one of them.
    mockSvc.fetchData.mockResolvedValue({
      ...TWO_SERIES_RESULT,
      key: 'USA.NGDP_RPCH+NGDPD.*',
      seriesAttributes: { unit: 'USD', scale: '9', decimals: 3 },
      seriesAttributesByKey: {
        'USA.NGDPD.A': { unit: 'USD', scale: '9', decimals: 3 },
        'USA.NGDP_RPCH.A': { unit: 'PT', scale: '0', decimals: 3 },
      },
    });
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH+NGDPD.*',
    });
    const structured = result.structuredContent as {
      series_metadata: Array<{ series_key: string; unit: string | null }>;
    };
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    expect(
      Object.fromEntries(structured.series_metadata.map((s) => [s.series_key, s.unit])),
    ).toEqual({ 'USA.NGDPD.A': 'USD', 'USA.NGDP_RPCH.A': 'PT' });
    expect(text).toMatch(/\|\s*USA\.NGDPD\.A\s*\|\s*USD\s*\|/);
    expect(text).toMatch(/\|\s*USA\.NGDP_RPCH\.A\s*\|\s*PT\s*\|/);
  });

  it('#15 lists one metadata entry per distinct series, not one per observation', async () => {
    const result = await twoSeriesResult();

    expect(result.observations).toHaveLength(4);
    expect(result.series_metadata).toHaveLength(2);
  });

  it('#15 leaves the single-series shape alone — no per-series list to read', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });
    const result = await imfQueryDataset.handler(input, ctx);

    expect(result.series_metadata).toBeUndefined();
    expect(result.series_attributes).toEqual(MOCK_SERIES_ATTRS);
  });

  it('#15 stages each canvas row with its own series attributes, not the last series decoded', async () => {
    let staged: Array<Record<string, unknown>> = [];
    const registerTable = vi.fn(
      async (_tableName: string, rows: Array<Record<string, unknown>>) => {
        staged = rows;
        return { tableName: 'imf_multi', rowCount: rows.length, columns: [] };
      },
    );
    const mockInstance = { canvasId: 'canvas-multi', registerTable };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue(mockInstance),
    });
    mockSvc.fetchData.mockResolvedValue(TWO_SERIES_RESULT);

    await imfQueryDataset.handler(
      imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH+NGDPD.A',
        output_mode: 'canvas',
      }),
      createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
    );

    // Every staged row must carry the scale of the series named in that row.
    for (const row of staged) {
      expect(row.scale).toBe(row.series_key === 'USA.NGDPD.A' ? '9' : '0');
    }
    expect(staged.filter((row) => row.series_key === 'USA.NGDPD.A')).toHaveLength(2);
  });

  it('#15 carries per-series metadata through a staged response too', async () => {
    const registerTable = vi.fn().mockResolvedValue({
      tableName: 'imf_multi',
      rowCount: TWO_SERIES_RESULT.observations.length,
      columns: [],
    });
    const mockInstance = { canvasId: 'canvas-multi', registerTable };
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue(mockInstance),
    });
    mockSvc.fetchData.mockResolvedValue(TWO_SERIES_RESULT);

    const result = await imfQueryDataset.handler(
      imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH+NGDPD.A',
        output_mode: 'canvas',
      }),
      createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
    );

    expect(result).toMatchObject({ staged: true, truncated: false });
    expect(result.observations).toHaveLength(4);
    expect(result.series_metadata?.map((series) => series.series_key)).toEqual([
      'USA.NGDPD.A',
      'USA.NGDP_RPCH.A',
    ]);
  });

  it('#15 renders each series’ own scale in content[], with the sentinel named', async () => {
    mockSvc.fetchData.mockResolvedValue(TWO_SERIES_RESULT);
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH+NGDPD.A',
    });
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    expect(text).toMatch(/\|\s*USA\.NGDPD\.A\s*\|\s*US Dollar\s*\|\s*9\s*\|/);
    expect(text).toMatch(/\|\s*USA\.NGDP_RPCH\.A\s*\|\s*—\s*\|\s*no scale multiplier\s*\|/);
  });

  it('#15 caps the rendered series table and says so, keeping every entry in structuredContent', async () => {
    // A `*` key resolves to hundreds of series; the table is bounded, the data is not.
    const many = Array.from({ length: 40 }, (_, i) => `C${String(i).padStart(3, '0')}.NGDPD.A`);
    mockSvc.fetchData.mockResolvedValue({
      ...TWO_SERIES_RESULT,
      observations: many.map((series_key) => ({
        series_key,
        time_period: '2020',
        value: 1,
        status: null,
      })),
      seriesAttributesByKey: Object.fromEntries(many.map((key) => [key, NGDPD_ATTRS])),
    });
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: '*.NGDPD.A',
    });
    const structured = result.structuredContent as { series_metadata: unknown[] };
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    expect(structured.series_metadata).toHaveLength(40);
    expect(text).toContain('20 of 40 series shown');
    // Attribute rows carry unit/scale/decimals; observation rows carry values,
    // so counting the attribute shape is what measures the rendered table.
    const attributeRows = text.match(/\|\s*C\d{3}\.NGDPD\.A\s*\|\s*US Dollar\s*\|/g) ?? [];
    expect(attributeRows).toHaveLength(20);
    expect(text).toContain('every entry remains in structuredContent');
    expect(text).not.toContain('canvas');
  });

  // -------------------------------------------------------------------------
  // #18: structuredContent and content[] carry the same series metadata
  // -------------------------------------------------------------------------

  it('#18 surfaces the same series attributes in both channels for a single series', async () => {
    const attrs = { unit: null, scale: '0', decimals: 0 };
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      seriesAttributes: attrs,
      seriesAttributesByKey: { 'USA.NGDP_RPCH.A': attrs },
    });
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
      start_period: '2020',
      end_period: '2024',
    });
    const structured = result.structuredContent as {
      series_attributes: { unit: string | null; scale: string | null; decimals: number | null };
    };
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    // structuredContent keeps the raw upstream sentinel …
    expect(structured.series_attributes).toEqual(attrs);
    // … and content[] states the same facts without printing a bare 0.
    const cells = seriesLineCells(text);
    expect(cells).toContain('no scale multiplier');
    expect(cells).toContain('0 decimals');
    expect(cells).not.toContain('0');
  });

  it('#18 surfaces per-series attributes in both channels for a multi-series query', async () => {
    mockSvc.fetchData.mockResolvedValue(TWO_SERIES_RESULT);
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH+NGDPD.A',
    });
    const structured = result.structuredContent as {
      series_metadata: Array<{ series_key: string; scale: string | null }>;
    };
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    for (const series of structured.series_metadata) {
      expect(text).toContain(series.series_key);
    }
    // Scale 9 reaches the text channel; the "0" sentinel reaches it named.
    expect(text).toContain('9');
    expect(text).toContain('no scale multiplier');
  });

  // -------------------------------------------------------------------------
  // #31: an empty dataflow is not an uncovered code
  // -------------------------------------------------------------------------

  /** Drive the no_data path with a chosen pair of availability answers. */
  const noDataFor = async (
    keyed: Availability | null,
    dataflowWide: Availability | null,
    input: { dataflow_id: string; key: string },
  ) => {
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
    availabilityByScope(keyed, dataflowWide);
    // The DSDs differ in width across these dataflows (CPI has five dimensions,
    // EER three), and a key that fails the arity check never reaches no_data.
    const segments = input.key.split('.');
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dataflowId: input.dataflow_id,
      keyFormat: segments.map((_, i) => `DIM_${i + 1}`).join('.'),
      dimensions: segments.map((_, i) => ({
        id: `DIM_${i + 1}`,
        name: `Dimension ${i + 1}`,
        position: i,
        codelist: [],
      })),
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    return captureMcpError(() => imfQueryDataset.handler(imfQueryDataset.input.parse(input), ctx));
  };

  it('#31 says the dataflow itself is empty when no code anywhere has data', async () => {
    const err = await noDataFor(availability(0), availability(0), {
      dataflow_id: 'CPI_2026_MAY_VINTAGE',
      key: 'USA.CPI._T.IX.M',
    });

    expect(err.data?.reason).toBe('no_data');
    expect(err.message).toContain('publishes no series at all');
    // The caller's own code is not what is being blamed.
    expect(err.message).not.toContain("'USA' has 0 series");
  });

  it('#31 points recovery at a different dataflow, never at another code', async () => {
    const err = await noDataFor(availability(0), availability(0), {
      dataflow_id: 'CPI_2026_MAY_VINTAGE',
      key: 'USA.CPI._T.IX.M',
    });

    expect(recoveryHint(err)).toContain('imf_list_databases');
    // "Try a different code" is the loop with no exit — every code fails here.
    expect(recoveryHint(err)).not.toMatch(/different code/i);
  });

  it('#31 gives every code the same empty-dataflow answer', async () => {
    const first = await noDataFor(availability(0), availability(0), {
      dataflow_id: 'CPI_2026_MAY_VINTAGE',
      key: 'USA.CPI._T.IX.M',
    });
    const second = await noDataFor(availability(0), availability(0), {
      dataflow_id: 'CPI_2026_MAY_VINTAGE',
      key: 'GBR.CPI._T.IX.M',
    });

    expect(second.message).toBe(first.message);
    expect(recoveryHint(second)).toBe(recoveryHint(first));
  });

  it('#31 still blames the code when the dataflow does publish series', async () => {
    const err = await noDataFor(
      availability(0),
      availability(732, { COUNTRY: { count: 165, codes: ['USA', 'GBR', 'DEU'] } }),
      { dataflow_id: 'EER', key: 'TUR.REER_IX_RY2010_ACW_RCPI.M' },
    );

    expect(err.message).toContain("'TUR' has 0 series in 'EER'");
    expect(recoveryHint(err)).toMatch(/different code/i);
  });

  it('#31 names codes that do have data so the retry has somewhere to go', async () => {
    const err = await noDataFor(
      availability(0),
      availability(732, { COUNTRY: { count: 165, codes: ['USA', 'GBR', 'DEU'] } }),
      { dataflow_id: 'EER', key: 'TUR.REER_IX_RY2010_ACW_RCPI.M' },
    );

    expect(err.message).toContain('COUNTRY: 3 of 165 codes with data shown (USA, GBR, DEU)');
    expect(recoveryHint(err)).toContain('USA');
  });

  it('#31 asks the dataflow-wide constraint only when the code probe came back empty', async () => {
    await noDataFor(
      availability(9, { INDICATOR: { count: 2, codes: ['A', 'B'] } }),
      availability(9),
      { dataflow_id: 'MFS_IR', key: 'TUR.MFS135.M' },
    );

    // series_count > 0 already identifies the failure as a wrong combination.
    const scopes = mockSvc.fetchAvailabilityConstraint.mock.calls.map((call) => call[1]);
    expect(scopes).toEqual(['TUR']);
  });

  it('#31 degrades to the code-scoped diagnosis when the dataflow-wide probe fails', async () => {
    const err = await noDataFor(availability(0), null, {
      dataflow_id: 'EER',
      key: 'TUR.REER_IX_RY2010_ACW_RCPI.M',
    });

    expect(err.message).toContain("'TUR' has 0 series in 'EER'");
    expect(err.message).not.toContain('publishes no series at all');
  });

  it('#24 keeps the dataflow_list_unavailable reason instead of relabeling it structure_unavailable', async () => {
    mockSvc.findDataflow.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));

    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain('/structure/');
  });
});
