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

import { z } from '@cyanheads/mcp-ts-core';
import { CanvasRegistry, DataCanvas, DuckdbProvider } from '@cyanheads/mcp-ts-core/canvas';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMcpError, contractError, recoveryHint } from '../helpers/errors.js';

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

/** The slice of a JSON Schema node the description assertions walk. */
interface JsonSchemaNode {
  description?: string;
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
}

/**
 * A canvas id to accumulate into, in the shape `CanvasIdSchema` advertises —
 * 10 characters from `[A-Za-z0-9_-]`. `canvas_id` is validated as an argument,
 * so a badly-shaped literal never reaches the handler.
 */
const EXISTING_CANVAS_ID = 'cvExisting';

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
      // Resolves whichever id was asked for, in the catalog's upper-case spelling —
      // the tool carries the catalog's id, not its input, into every later call.
      findDataflow: vi
        .fn()
        .mockImplementation((dataflowId: string) =>
          Promise.resolve({ ...MOCK_DATAFLOW, id: dataflowId.trim().toUpperCase() }),
        ),
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

  it('#50 leaves an under-budget result whole and unguided when DataCanvas is disabled', async () => {
    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
    });
    const structured = result.structuredContent as Record<string, unknown>;
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    expect(structured).toMatchObject({ staged: false, truncated: false, observation_count: 3 });
    expect(structured.observations).toEqual(MOCK_OBSERVATIONS);
    expect(structured).not.toHaveProperty('retrieval_guidance');
    expect(structured).not.toHaveProperty('canvas_id');
    expect(text).toContain('**Truncated:** false');
    expect(text).not.toContain('\n> ');
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
      undefined,
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
    const acquire = vi.fn().mockResolvedValue({ canvasId: EXISTING_CANVAS_ID, registerTable });
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({ acquire });

    const staged = await imfQueryDataset.handler(
      imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        canvas_id: EXISTING_CANVAS_ID,
        output_mode: 'canvas',
      }),
      createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
    );
    const automatic = await imfQueryDataset.handler(
      imfQueryDataset.input.parse({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        canvas_id: EXISTING_CANVAS_ID,
      }),
      createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
    );

    expect(acquire).toHaveBeenCalledWith(EXISTING_CANVAS_ID, expect.anything());
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

  // -------------------------------------------------------------------------
  // #50: without DataCanvas, the response budget still holds
  // -------------------------------------------------------------------------

  /** The envelope `serializedResultChars` measures: both result channels together. */
  const envelopeChars = (result: Awaited<ReturnType<typeof runToolContract>>) =>
    JSON.stringify({ structuredContent: result.structuredContent, content: result.content }).length;

  interface TruncatedInline {
    notice?: string;
    observation_count: number;
    observations: Array<{ series_key: string; time_period: string }>;
    retrieval_guidance: string;
    series_metadata?: Array<{ series_key: string }>;
    staged: boolean;
    truncated: boolean;
  }

  /** The guidance a canvas-off truncation carries, checked the same way in either channel. */
  const expectInlineGuidance = (channel: string) => {
    expect(channel).toContain('start_period');
    expect(channel).toContain('end_period');
    expect(channel).toContain('last_n_observations');
    expect(channel).toContain('CANVAS_PROVIDER_TYPE=duckdb');
    // Those tools are not registered without a canvas, so nothing may point at them.
    expect(channel).not.toContain('imf_dataframe');
  };

  it('#50 returns a time-ascending prefix across series when an over-budget result has no canvas', async () => {
    const series = ['USA.NGDP_RPCH.A', 'GBR.NGDP_RPCH.A', 'DEU.NGDP_RPCH.A'];
    // Interleaved in time order, as the service returns them, then one label the
    // range filter cannot read, so the period notice rides the measured envelope.
    const observations = Array.from({ length: 1_800 }, (_, period) =>
      series.map((series_key, s) => ({
        series_key,
        time_period: `${1850 + Math.floor(period / 12)}-M${String((period % 12) + 1).padStart(2, '0')}`,
        value: period + s / 10 + 0.123456,
        status: period % 7 === 0 ? 'E' : null,
      })),
    )
      .flat()
      .concat({ series_key: series[0]!, time_period: '2000-W07', value: 1, status: null });
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      key: 'USA+GBR+DEU.NGDP_RPCH.A',
      observations,
      seriesAttributesByKey: Object.fromEntries(series.map((key) => [key, NGDP_RPCH_ATTRS])),
    });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA+GBR+DEU.NGDP_RPCH.A',
      end_period: '2100',
    });
    const structured = result.structuredContent as TruncatedInline;
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');
    const shown = structured.observations;

    expect(envelopeChars(result)).toBeLessThanOrEqual(100_000);
    // The largest prefix that fits, not an arbitrary short one.
    expect(envelopeChars(result)).toBeGreaterThan(99_000);
    expect(structured).toMatchObject({
      staged: false,
      truncated: true,
      observation_count: observations.length,
    });
    expect(structured).not.toHaveProperty('canvas_id');
    expect(structured).not.toHaveProperty('table_name');
    expect(shown.length).toBeGreaterThan(0);
    expect(shown).toEqual(observations.slice(0, shown.length));
    // The prefix is cut by time, not by series: every series reaches it.
    expect(new Set(shown.map((obs) => obs.series_key))).toEqual(new Set(series));
    expect(structured.series_metadata?.map((entry) => entry.series_key)).toEqual(series);

    const last = shown.at(-1)!.time_period;
    for (const channel of [structured.retrieval_guidance, text]) {
      expect(channel).toContain(`time_period ${last}`);
      expect(channel).toContain(`${shown.length} of ${observations.length}`);
      expectInlineGuidance(channel);
    }
    expect(text).toContain(structured.retrieval_guidance);
    expect(text).toContain('**Staged:** false | **Truncated:** true');
    expect(structured.notice).toContain('2000-W07');
    expect(text).toContain(structured.notice);
  });

  it('#50 cuts one long series the same way, with no per-series list to carry', async () => {
    const observations = Array.from({ length: 1_500 }, (_, index) => ({
      series_key: 'USA.NGDP_RPCH.A',
      time_period: `PERIOD_WITH_A_LONG_LABEL_${String(index).padStart(4, '0')}`,
      value: index + 0.123456,
      status: null,
    }));
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
    });
    const structured = result.structuredContent as TruncatedInline;
    const shown = structured.observations;

    expect(envelopeChars(result)).toBeLessThanOrEqual(100_000);
    expect(structured).toMatchObject({ staged: false, truncated: true, observation_count: 1_500 });
    expect(structured).not.toHaveProperty('series_metadata');
    expect(shown).toEqual(observations.slice(0, shown.length));
    expect(shown.length).toBeLessThan(1_500);
    expect(structured.retrieval_guidance).toContain(`time_period ${shown.at(-1)!.time_period}`);
  });

  it('#50 returns no observations, still guided, when not even the first one fits without a canvas', async () => {
    // One observation larger than the whole budget: the prefix that fits is empty.
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: [
        {
          series_key: 'USA.NGDP_RPCH.A',
          time_period: '2020',
          value: null,
          status: 'X'.repeat(60_000),
        },
        ...MOCK_OBSERVATIONS.slice(1),
      ],
    });

    const result = await runToolContract(imfQueryDataset, {
      dataflow_id: 'WEO',
      key: 'USA.NGDP_RPCH.A',
    });
    const structured = result.structuredContent as TruncatedInline;
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    expect(result.isError).toBeFalsy();
    expect(envelopeChars(result)).toBeLessThanOrEqual(100_000);
    expect(structured).toMatchObject({ staged: false, truncated: true, observation_count: 3 });
    expect(structured.observations).toEqual([]);
    expect(structured.retrieval_guidance).not.toContain('time_period ');
    expectInlineGuidance(structured.retrieval_guidance);
    expect(text).toContain(structured.retrieval_guidance);
  });

  it('#50 raises response_too_large without naming a staged handle when metadata alone overflows and there is no canvas', async () => {
    const series = Array.from(
      { length: 1_200 },
      (_, index) => `C${String(index).padStart(4, '0')}.${'LONG_INDICATOR_'.repeat(8)}.A`,
    );
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: series.map((series_key, index) => ({
        series_key,
        time_period: '2023',
        value: index,
        status: null,
      })),
      seriesAttributesByKey: Object.fromEntries(series.map((key) => [key, NGDPD_ATTRS])),
    });

    const result = await runToolContract(imfQueryDataset, { dataflow_id: 'WEO', key: '*.NGDPD.A' });
    const error = contractError(result);
    const hint = (error.data?.recovery as { hint: string } | undefined)?.hint ?? '';
    const text = (result.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data).toMatchObject({
      reason: 'response_too_large',
      seriesCount: 1_200,
      budgetChars: 100_000,
    });
    expect(hint).toContain('Narrow the dimension key');
    for (const wording of [hint, error.message, text]) {
      expect(wording).not.toMatch(/staged|handle|canvas/i);
    }
  });

  it('declares response_too_large at warning severity, since a too-broad key is the caller’s to narrow', () => {
    const entry = imfQueryDataset.errors?.find((e) => e.reason === 'response_too_large');
    expect(entry?.severity).toBe('warning');
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

  it('renders each observation as one table row carrying its status', () => {
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
    const lines = (imfQueryDataset.format!(output)[0] as { text: string }).text.split('\n');

    expect(lines).toContain('| USA.NGDP_RPCH.A | 2020 | 3.5 | — |');
    expect(lines).toContain('| USA.NGDP_RPCH.A | 2021 | 5.1 | E |');
  });

  /**
   * GFM cells of one rendered table row. A backslash escapes the character after
   * it, so only an unescaped `|` divides cells — the rule a markdown renderer
   * applies, and the one a status carrying a `|` has to survive.
   */
  const rowCells = (row: string): string[] => {
    const cells: string[] = [];
    let cell = '';
    for (let i = 0; i < row.length; i++) {
      const ch = row[i];
      if (ch === '\\' && i + 1 < row.length) {
        cell += ch + row[i + 1];
        i++;
      } else if (ch === '|') {
        cells.push(cell.trim());
        cell = '';
      } else {
        cell += ch;
      }
    }
    cells.push(cell.trim());
    return cells.slice(1, -1);
  };

  it('escapes a status that would split, restyle, or break its table row', () => {
    const statuses = ['a|b', '`', '/temporarily removed 148118', 'end\\|', 'first line\nsecond'];
    const output = {
      dataflow_id: 'FAS',
      key: 'USA.X.A',
      observations: statuses.map((status, i) => ({
        series_key: 'USA.X.A',
        time_period: `${2020 + i}`,
        value: null,
        status,
      })),
      series_attributes: { unit: null, scale: null, decimals: null },
      observation_count: statuses.length,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, FAS, https://data.imf.org/',
    };
    const rows = (imfQueryDataset.format!(output)[0] as { text: string }).text
      .split('\n')
      .filter((line) => line.startsWith('| USA.X.A |'));

    expect(rows).toHaveLength(statuses.length);
    rows.forEach((row, i) => {
      const cells = rowCells(row);
      // An unescaped | adds a cell; the row keeps exactly its four.
      expect.soft(cells).toHaveLength(4);
      // A backtick left bare can open a code span across the rest of the row.
      expect.soft(cells[3]).not.toMatch(/(^|[^\\])`/);
      // Stripping the escapes gives back the status as published, line breaks aside.
      expect.soft(cells[3]?.replace(/\\(.)/g, '$1')).toBe(statuses[i]!.replace(/\n/g, ' '));
    });
  });

  it('keeps a | in any upstream-sourced cell inside that cell, in both tables', () => {
    const output = {
      dataflow_id: 'FAS',
      key: 'A|B.X.A+C.X.A',
      observations: [
        { series_key: 'A|B.X.A', time_period: '2020|S1', value: 1, status: null },
        { series_key: 'C.X.A', time_period: '2020', value: 2, status: null },
      ],
      series_attributes: { unit: 'USD|EUR', scale: '9|x', decimals: 2 },
      series_metadata: [
        { series_key: 'A|B.X.A', unit: 'USD|EUR', scale: '9|x', decimals: 2 },
        { series_key: 'C.X.A', unit: null, scale: null, decimals: null },
      ],
      observation_count: 2,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, FAS, https://data.imf.org/',
    };
    const rows = (imfQueryDataset.format!(output)[0] as { text: string }).text
      .split('\n')
      .filter((line) => line.startsWith('| ') && !line.startsWith('| Series Key |'));

    // Each row keeps exactly its four cells, and unescaping gives back the upstream text.
    expect(rows.map((row) => rowCells(row).map((cell) => cell.replace(/\\(.)/g, '$1')))).toEqual([
      ['A|B.X.A', 'USD|EUR', 'published in units of 10^9|x', '2'],
      ['C.X.A', '—', '—', '—'],
      ['A|B.X.A', '2020|S1', '1', '—'],
      ['C.X.A', '2020', '2', '—'],
    ]);
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
    expect(cells).toContain('published in units');
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

  it('#51 renders a non-zero scale as the power of ten the series is published in', () => {
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
    const text = (imfQueryDataset.format!(output)[0] as { text: string }).text;
    const cells = seriesLineCells(text);

    expect(cells).toEqual(['US Dollar', 'published in units of 10^9', '3 decimals']);
    // Values are already in base units; the header says so beside the scale.
    expect(text.split('\n')).toContain(
      '| Series Key | Time Period | Value (base units) | Status |',
    );
  });

  it('#51 names a scale with no unit beside it, never a bare code', () => {
    const output = {
      dataflow_id: 'BOP',
      key: 'USA.NETCD_T.CAB.USD.A',
      observations: [
        {
          series_key: 'USA.NETCD_T.CAB.USD.A',
          time_period: '2024',
          value: -1_198_628_000_000,
          status: null,
        },
      ],
      series_attributes: { unit: null, scale: '6', decimals: null },
      observation_count: 1,
      staged: false,
      truncated: false,
      source: 'Source: International Monetary Fund, Balance of Payments, https://data.imf.org/',
    };
    const text = (imfQueryDataset.format!(output)[0] as { text: string }).text;

    expect(text.split('\n')).toContain('**Series:** published in units of 10^6');
  });

  it('#51 describes scale as a publication power of ten and values as base units', () => {
    const schema = z.toJSONSchema(imfQueryDataset.output) as {
      properties: Record<string, JsonSchemaNode>;
    };
    const seriesScale = schema.properties.series_attributes?.properties?.scale?.description ?? '';
    const entryScale =
      schema.properties.series_metadata?.items?.properties?.scale?.description ?? '';
    const value = schema.properties.observations?.items?.properties?.value?.description ?? '';

    for (const scale of [seriesScale, entryScale]) {
      expect(scale).toMatch(/power of ten/i);
      expect(scale).toContain('base units');
    }
    expect(value).toContain('base units');
    expect(imfQueryDataset.description).toContain('base units');
    // Nothing the tool publishes may call scale a multiplier or the values unscaled.
    const published = JSON.stringify({
      description: imfQueryDataset.description,
      input: z.toJSONSchema(imfQueryDataset.input),
      output: schema,
      errors: imfQueryDataset.errors,
    });
    expect(published).not.toMatch(/multiplier|unscaled/i);
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
  // #57: a not-available status is padding too
  // -------------------------------------------------------------------------

  /**
   * Null-value rows as `ER`, `CPI`, `FAS`, `FSIBSIS` and `IIPCC` ship them once
   * STATUS decodes, beside rows with values. `NA`, `n.a.` and `na` say only that
   * the value is not available, which a null value already says; every other
   * status says something the null does not.
   */
  const STATUS_ROWS = [
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M01', value: null, status: 'NA' },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M02', value: null, status: 'n.a.' },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M03', value: null, status: 'na' },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M04', value: null, status: null },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M05', value: null, status: 'C' },
    {
      series_key: 'HTI.XDC_USD.PA_RT.M',
      time_period: '1991-M06',
      value: null,
      status: '/temporarily removed 148118',
    },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M07', value: null, status: 'T' },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M08', value: 7.3, status: 'NA' },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M09', value: 7.45, status: 'T' },
    { series_key: 'HTI.XDC_USD.PA_RT.M', time_period: '1991-M10', value: 7.5, status: null },
  ];
  const KEPT_STATUS_PERIODS = [
    '1991-M05',
    '1991-M06',
    '1991-M07',
    '1991-M08',
    '1991-M09',
    '1991-M10',
  ];

  /** `ER`'s four-position key shape, codelists empty so any code passes unchecked. */
  const serveErRows = (observations: typeof STATUS_ROWS) => {
    mockSvc.fetchDataflowStructure.mockResolvedValue({
      ...MOCK_STRUCTURE,
      dataflowId: 'ER',
      keyFormat: 'COUNTRY.INDICATOR.TYPE_OF_TRANSFORMATION.FREQUENCY',
      dimensions: ['COUNTRY', 'INDICATOR', 'TYPE_OF_TRANSFORMATION', 'FREQUENCY'].map(
        (id, position) => ({ id, name: id, position, codelist: [] }),
      ),
    });
    mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations });
  };

  it('#57 drops a null value whose only status is NA, n.a. or na, and keeps every other status', async () => {
    serveErRows(STATUS_ROWS);

    const response = await runToolContract(imfQueryDataset, {
      dataflow_id: 'ER',
      key: 'HTI.XDC_USD.PA_RT.M',
    });
    const structured = response.structuredContent as {
      observations: Array<{ time_period: string; value: number | null; status: string | null }>;
      observation_count: number;
    };
    const text = (response.content as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n');

    expect(structured.observations.map((obs) => obs.time_period)).toEqual(KEPT_STATUS_PERIODS);
    expect(structured.observation_count).toBe(KEPT_STATUS_PERIODS.length);
    expect(structured.observations.find((obs) => obs.time_period === '1991-M09')).toEqual({
      series_key: 'HTI.XDC_USD.PA_RT.M',
      time_period: '1991-M09',
      value: 7.45,
      status: 'T',
    });
    for (const period of ['1991-M01', '1991-M02', '1991-M03', '1991-M04']) {
      expect(text).not.toContain(period);
    }
    expect(text).toContain('| HTI.XDC_USD.PA_RT.M | 1991-M09 | 7.45 | T |');
    expect(text).toContain('| HTI.XDC_USD.PA_RT.M | 1991-M05 | — | C |');
    expect(text).toContain('| HTI.XDC_USD.PA_RT.M | 1991-M06 | — | /temporarily removed 148118 |');
    expect(text).toContain('| HTI.XDC_USD.PA_RT.M | 1991-M08 | 7.3 | NA |');
  });

  it('#57 stages the same rows on the canvas path', async () => {
    let staged: Array<Record<string, unknown>> = [];
    const registerTable = vi.fn(
      async (_tableName: string, rows: Array<Record<string, unknown>>) => {
        staged = rows;
        return { tableName: 'imf_status', rowCount: rows.length, columns: [] };
      },
    );
    (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
      acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-status', registerTable }),
    });
    serveErRows(STATUS_ROWS);

    const result = await imfQueryDataset.handler(
      imfQueryDataset.input.parse({
        dataflow_id: 'ER',
        key: 'HTI.XDC_USD.PA_RT.M',
        output_mode: 'canvas',
      }),
      createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
    );

    expect(result.staged).toBe(true);
    expect(staged.map((row) => [row.time_period, row.value, row.status])).toEqual([
      ['1991-M05', null, 'C'],
      ['1991-M06', null, '/temporarily removed 148118'],
      ['1991-M07', null, 'T'],
      ['1991-M08', 7.3, 'NA'],
      ['1991-M09', 7.45, 'T'],
      ['1991-M10', 7.5, null],
    ]);
  });

  it('#57 reports no_data when every row is a null value marked not available', async () => {
    serveErRows(STATUS_ROWS.slice(0, 4));

    const error = contractError(
      await runToolContract(imfQueryDataset, { dataflow_id: 'ER', key: 'HTI.XDC_USD.PA_RT.M' }),
    );

    expect(error.data).toMatchObject({ reason: 'no_data' });
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
    expect(text.split('\n')).toContain('**Period:** 2020 – 2022');
  });

  /** The rendered Period line for a result echoing the given bounds. */
  const periodLine = (bounds: { start_period?: string; end_period?: string }) =>
    (
      imfQueryDataset.format!({
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        ...bounds,
        observations: MOCK_OBSERVATIONS,
        series_attributes: MOCK_SERIES_ATTRS,
        observation_count: 3,
        staged: false,
        truncated: false,
        source:
          'Source: International Monetary Fund, World Economic Outlook, https://data.imf.org/',
      })[0] as { text: string }
    ).text
      .split('\n')
      .find((line) => line.startsWith('**Period:**'));

  it('says which bound a lone end_period or start_period is', () => {
    expect(periodLine({ end_period: '2020' })).toBe('**Period:** through 2020');
    expect(periodLine({ start_period: '2020' })).toBe('**Period:** from 2020');
    expect(periodLine({ start_period: '2020', end_period: '2022' })).toBe(
      '**Period:** 2020 – 2022',
    );
    expect(periodLine({})).toBeUndefined();
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

  it('#22 names a lone bound as the one it is in the no_data_in_range message', async () => {
    mockSvc.fetchData.mockResolvedValue({
      ...MOCK_QUERY_RESULT,
      observations: CPI_OBSERVATIONS,
    });
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });

    const fromErr = await captureMcpError(() =>
      imfQueryDataset.handler(
        imfQueryDataset.input.parse({ dataflow_id: 'CPI', key: 'USA.CPI.M', start_period: '2027' }),
        ctx,
      ),
    );
    expect(fromErr.data?.reason).toBe('no_data_in_range');
    expect(fromErr.message).toContain('(from 2027)');

    const throughErr = await captureMcpError(() =>
      imfQueryDataset.handler(
        imfQueryDataset.input.parse({ dataflow_id: 'CPI', key: 'USA.CPI.M', end_period: '1900' }),
        ctx,
      ),
    );
    expect(throughErr.data?.reason).toBe('no_data_in_range');
    expect(throughErr.message).toContain('(through 1900)');
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
      undefined,
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

    expect(text).toMatch(
      /\|\s*USA\.NGDPD\.A\s*\|\s*US Dollar\s*\|\s*published in units of 10\^9\s*\|/,
    );
    expect(text).toMatch(/\|\s*USA\.NGDP_RPCH\.A\s*\|\s*—\s*\|\s*published in units\s*\|/);
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
    expect(cells).toContain('published in units');
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
    // Both scales reach the text channel named, as publication powers of ten.
    expect(text).toContain('published in units of 10^9');
    expect(text).toMatch(/\|\s*published in units\s*\|/);
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

  it('#55 sends both availability probes the resolved agency, id, and version', async () => {
    // GPT is published by IMF.SPR; a probe naming it by bare id 404s upstream.
    const gpt = { agencyId: 'IMF.SPR', id: 'GPT', version: '1.0.1' };
    mockSvc.findDataflow.mockResolvedValue({ ...gpt, name: 'IMF Global Policy Tracker' });

    const err = await noDataFor(
      availability(0),
      availability(821, { COUNTRY: { count: 2, codes: ['USA', 'GBR'] } }),
      { dataflow_id: 'GPT', key: 'TUR.POLICY.A' },
    );

    const probes = mockSvc.fetchAvailabilityConstraint.mock.calls.map(([ref, code]) => ({
      ref,
      code,
    }));
    expect(probes).toEqual([
      { ref: expect.objectContaining(gpt), code: 'TUR' },
      { ref: expect.objectContaining(gpt), code: '' },
    ]);
    // Both answers reach the diagnosis instead of degrading to the generic message.
    expect(err.message).toContain("'TUR' has 0 series in 'GPT'");
    expect(err.message).toContain('USA, GBR');
  });

  it('#24 keeps the dataflow_list_unavailable reason instead of relabeling it structure_unavailable', async () => {
    mockSvc.findDataflow.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));

    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain('/structure/');
  });

  it('keeps dataflow_list_unavailable from the structure lookup instead of relabeling it structure_unavailable', async () => {
    mockSvc.fetchDataflowStructure.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors });
    const input = imfQueryDataset.input.parse({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });

    const err = await captureMcpError(() => imfQueryDataset.handler(input, ctx));

    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(recoveryHint(err)).toContain('Retry');
    expect(mockSvc.fetchData).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // #52: keys normalize to codelist spellings; unknown codes fail before the fetch
  // -------------------------------------------------------------------------

  describe('#52 key normalization and the codelist check', () => {
    /**
     * WEO's key shape with populated codelists, in live codelist order where it
     * matters: NGDP_RPCHMK precedes NGDP_RPCH. Seven NGDP* codes let a prefix
     * overflow the five-suggestion cap.
     */
    const WEO_CODED_STRUCTURE = {
      ...MOCK_STRUCTURE,
      dimensions: [
        {
          id: 'COUNTRY',
          name: 'Country',
          position: 0,
          codelist: [
            { id: 'USA', name: 'United States' },
            { id: 'GBR', name: 'United Kingdom' },
            { id: 'DEU', name: 'Germany' },
            { id: 'TUR', name: 'Türkiye' },
          ],
        },
        {
          id: 'INDICATOR',
          name: 'Indicator',
          position: 1,
          codelist: [
            { id: 'NGDP_RPCHMK', name: 'GDP, constant market prices, percent change' },
            { id: 'NGDP_RPCH', name: 'GDP, constant prices, percent change' },
            { id: 'NGDPD', name: 'GDP, current prices, US dollars' },
            { id: 'NGDP_D', name: 'GDP deflator' },
            { id: 'NGDP_R', name: 'GDP, constant prices, domestic currency' },
            { id: 'NGDPPC', name: 'GDP per capita, current prices' },
            { id: 'NGDP', name: 'GDP, current prices, domestic currency' },
          ],
        },
        {
          id: 'FREQUENCY',
          name: 'Frequency',
          position: 2,
          codelist: [
            { id: 'A', name: 'Annual' },
            { id: 'Q', name: 'Quarterly' },
            { id: 'M', name: 'Monthly' },
          ],
        },
      ],
    };

    const contractRecovery = (reason: string) =>
      imfQueryDataset.errors?.find((entry) => entry.reason === reason)?.recovery ?? '';

    const contentText = (response: Awaited<ReturnType<typeof runToolContract>>) =>
      (response.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n');

    const query = (key: string, extra: Record<string, unknown> = {}) =>
      runToolContract(imfQueryDataset, { dataflow_id: 'WEO', key, ...extra });

    /** The key each fetchData call sent upstream (argument 4). */
    const fetchedKeys = () => mockSvc.fetchData.mock.calls.map((call) => call[3]);

    beforeEach(() => {
      mockSvc.fetchDataflowStructure.mockResolvedValue(WEO_CODED_STRUCTURE);
    });

    it('rejects an ISO-2 country as invalid_key_code suggesting its ISO-3 code, with no data request', async () => {
      for (const [iso2, iso3] of [
        ['US', 'USA'],
        ['GB', 'GBR'],
        ['DE', 'DEU'],
      ] as const) {
        const response = await query(`${iso2}.NGDP_RPCH.A`);
        const error = contractError(response);
        const text = contentText(response);

        expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
        expect(error.data).toMatchObject({
          reason: 'invalid_key_code',
          key: `${iso2}.NGDP_RPCH.A`,
          keyFormat: 'COUNTRY.INDICATOR.FREQUENCY',
          invalidCodes: [{ position: 1, dimension: 'COUNTRY', code: iso2, suggestions: [iso3] }],
        });
        expect(error.message).toContain(
          `position 1 (COUNTRY) '${iso2}' — nearest COUNTRY codes: ${iso3}`,
        );
        expect(text).toContain(`position 1 (COUNTRY) '${iso2}' — nearest COUNTRY codes: ${iso3}`);
        // The declared recovery reaches both surfaces without being forwarded by hand.
        expect(error.data?.recovery).toEqual({ hint: contractRecovery('invalid_key_code') });
        expect(text).toContain(contractRecovery('invalid_key_code'));
      }
      expect(mockSvc.fetchData).not.toHaveBeenCalled();
      expect(mockSvc.fetchAvailabilityConstraint).not.toHaveBeenCalled();
    });

    it('suggests codes sharing the prefix in codelist order for a truncated indicator', async () => {
      const response = await query('USA.NGDP_RPC.A');
      const error = contractError(response);

      expect(error.data?.invalidCodes).toEqual([
        {
          position: 2,
          dimension: 'INDICATOR',
          code: 'NGDP_RPC',
          suggestions: ['NGDP_RPCHMK', 'NGDP_RPCH'],
        },
      ]);
      expect(contentText(response)).toContain(
        "position 2 (INDICATOR) 'NGDP_RPC' — nearest INDICATOR codes: NGDP_RPCHMK, NGDP_RPCH",
      );
    });

    it('caps suggestions at five, falls back to codes one edit away, and says when nothing is close', async () => {
      const suggestionsFor = async (key: string) => {
        const { data } = contractError(await query(key));
        return (data?.invalidCodes as Array<{ suggestions: string[] }> | undefined)?.[0]
          ?.suggestions;
      };

      // Seven indicator codes start with NGD; the first five in codelist order are named.
      expect(await suggestionsFor('USA.ngd.A')).toEqual([
        'NGDP_RPCHMK',
        'NGDP_RPCH',
        'NGDPD',
        'NGDP_D',
        'NGDP_R',
      ]);
      // No code starts with these — one substitution, deletion, or insertion away.
      expect(await suggestionsFor('USB.NGDP_RPCH.A')).toEqual(['USA']);
      expect(await suggestionsFor('GBRR.NGDP_RPCH.A')).toEqual(['GBR']);
      expect(await suggestionsFor('UA.NGDP_RPCH.A')).toEqual(['USA']);
      expect(await suggestionsFor('USA.ngdp_rpcx.A')).toEqual(['NGDP_RPCH']);

      const far = await query('ZZZZZ.NGDP_RPCH.A');
      expect(contractError(far).data?.invalidCodes).toEqual([
        { position: 1, dimension: 'COUNTRY', code: 'ZZZZZ', suggestions: [] },
      ]);
      expect(contentText(far)).toContain(
        "position 1 (COUNTRY) 'ZZZZZ' — no close match; page the COUNTRY codes with imf_get_database",
      );
    });

    it('reports every failing position and the dimension a misplaced code belongs to', async () => {
      const response = await query('NGDP_RPCH.USA.A');
      const error = contractError(response);
      const text = contentText(response);

      expect(error.data?.invalidCodes).toEqual([
        {
          position: 1,
          dimension: 'COUNTRY',
          code: 'NGDP_RPCH',
          suggestions: [],
          belongsTo: 'INDICATOR',
        },
        { position: 2, dimension: 'INDICATOR', code: 'USA', suggestions: [], belongsTo: 'COUNTRY' },
      ]);
      expect(text).toContain(
        "position 1 (COUNTRY) 'NGDP_RPCH' — belongs to INDICATOR, not COUNTRY",
      );
      expect(text).toContain("position 2 (INDICATOR) 'USA' — belongs to COUNTRY, not INDICATOR");
    });

    it('checks every + member at every position and reports only the members that fail', async () => {
      const response = await query('USA+GB.NGDP_RPCH+NGDP_RPC.a');
      const error = contractError(response);

      expect(error.data?.invalidCodes).toEqual([
        { position: 1, dimension: 'COUNTRY', code: 'GB', suggestions: ['GBR'] },
        {
          position: 2,
          dimension: 'INDICATOR',
          code: 'NGDP_RPC',
          suggestions: ['NGDP_RPCHMK', 'NGDP_RPCH'],
        },
      ]);
      expect(mockSvc.fetchData).not.toHaveBeenCalled();
    });

    it('resolves codes case-insensitively and trims whitespace, querying and echoing the canonical key', async () => {
      for (const key of [
        'usa.ngdp_rpch.a',
        'Usa.Ngdp_Rpch.a',
        ' USA.NGDP_RPCH.A ',
        '\tusa . ngdp_rpch . A\n',
      ]) {
        const response = await query(key);
        const structured = response.structuredContent as {
          key: string;
          observations: unknown[];
        };

        expect(response.isError).toBeFalsy();
        expect(structured.key).toBe('USA.NGDP_RPCH.A');
        expect(structured.observations).toEqual(MOCK_OBSERVATIONS);
        expect(contentText(response)).toContain('## IMF Data: WEO — `USA.NGDP_RPCH.A`');
      }
      expect(fetchedKeys()).toEqual(Array(4).fill('USA.NGDP_RPCH.A'));
    });

    it('trims and resolves each + member', async () => {
      const response = await query('usa + gbr.ngdp_rpch+ngdpd.a');

      expect(fetchedKeys()).toEqual(['USA+GBR.NGDP_RPCH+NGDPD.A']);
      expect((response.structuredContent as { key: string }).key).toBe('USA+GBR.NGDP_RPCH+NGDPD.A');
    });

    it('rejects * inside a + list as wildcard_in_code_list naming the position, with no data request', async () => {
      const response = await query('USA+*.NGDP_RPCH.A');
      const error = contractError(response);
      const text = contentText(response);

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.data).toMatchObject({
        reason: 'wildcard_in_code_list',
        key: 'USA+*.NGDP_RPCH.A',
        positions: [1],
        keyFormat: 'COUNTRY.INDICATOR.FREQUENCY',
      });
      expect(text).toContain('position 1 (COUNTRY)');
      expect(error.data?.recovery).toEqual({ hint: contractRecovery('wildcard_in_code_list') });
      expect(text).toContain(contractRecovery('wildcard_in_code_list'));
      expect(mockSvc.fetchData).not.toHaveBeenCalled();

      const both = contractError(await query(' * + usa .NGDP_RPCH+*.A'));
      expect(both.data).toMatchObject({ reason: 'wildcard_in_code_list', positions: [1, 2] });
      expect(both.message).toContain('position 1 (COUNTRY), 2 (INDICATOR)');
    });

    it('runs the checks in order: segment count, empty segment, * in a list, then codes', async () => {
      expect(contractError(await query('US.NGDP_RPCH')).data?.reason).toBe(
        'key_dimension_mismatch',
      );
      expect(contractError(await query('US..A')).data?.reason).toBe('empty_key_segment');
      expect(contractError(await query('US+*..A')).data?.reason).toBe('empty_key_segment');
      expect(contractError(await query('US+*.NGDP_RPCH.A')).data?.reason).toBe(
        'wildcard_in_code_list',
      );
      expect(mockSvc.fetchData).not.toHaveBeenCalled();
    });

    it('keeps wildcards, + lists, empty + members, and blank positions behaving as before', async () => {
      for (const key of [
        '*.NGDP_RPCH.A',
        'USA+GBR.NGDP_RPCH.A',
        'USA.NGDP_RPCH+NGDPD.A',
        'USA+.NGDP_RPCH.A',
      ]) {
        const response = await query(key);
        expect(response.isError).toBeFalsy();
        expect((response.structuredContent as { key: string }).key).toBe(key);
      }
      expect(fetchedKeys()).toEqual([
        '*.NGDP_RPCH.A',
        'USA+GBR.NGDP_RPCH.A',
        'USA.NGDP_RPCH+NGDPD.A',
        'USA+.NGDP_RPCH.A',
      ]);

      const blank = contractError(await query('USA..A'));
      expect(blank.data).toMatchObject({ reason: 'empty_key_segment', emptyPositions: [2] });
    });

    it('leaves a position unchecked when its codelist resolved empty', async () => {
      mockSvc.fetchDataflowStructure.mockResolvedValue({
        ...WEO_CODED_STRUCTURE,
        dimensions: WEO_CODED_STRUCTURE.dimensions.map((dimension) =>
          dimension.id === 'FREQUENCY' ? { ...dimension, codelist: [] } : dimension,
        ),
      });

      const response = await query('usa.ngdp_rpch.x');

      expect(response.isError).toBeFalsy();
      expect(fetchedKeys()).toEqual(['USA.NGDP_RPCH.x']);
    });

    it('resolves dataflow_id case-insensitively and uses the catalog spelling downstream and in every echo', async () => {
      // Echoes its argument, as the pre-#52 service did.
      mockSvc.fetchDataflowStructure.mockImplementation((dataflowId: string) =>
        Promise.resolve({ ...WEO_CODED_STRUCTURE, dataflowId }),
      );
      const registerTable = vi.fn().mockResolvedValue({
        tableName: 'imf_weo',
        rowCount: MOCK_OBSERVATIONS.length,
        columns: [],
      });
      const acquire = vi.fn().mockResolvedValue({ canvasId: 'canvas-weo', registerTable });
      (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({ acquire });

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'weo',
        key: 'usa.ngdp_rpch.a',
        output_mode: 'canvas',
      });
      const structured = response.structuredContent as { dataflow_id: string; key: string };

      expect(mockSvc.fetchDataflowStructure).toHaveBeenCalledWith(
        'WEO',
        'IMF.RES',
        '9.0.0',
        expect.anything(),
      );
      expect(mockSvc.fetchData).toHaveBeenCalledWith(
        'IMF.RES',
        'WEO',
        '9.0.0',
        'USA.NGDP_RPCH.A',
        undefined,
        undefined,
        expect.anything(),
        expect.anything(),
        undefined,
      );
      expect(structured).toMatchObject({ dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A' });
      expect(contentText(response)).toContain('## IMF Data: WEO — `USA.NGDP_RPCH.A`');
      const rows = registerTable.mock.calls[0]?.[1] as Array<{ dataflow_id: string }>;
      expect(rows.map((row) => row.dataflow_id)).toEqual(Array(3).fill('WEO'));
    });

    it('diagnoses a valid uncovered code through the availability probes with its canonical spelling', async () => {
      mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
      mockSvc.fetchAvailabilityConstraint.mockImplementation((_flow: unknown, code: string) =>
        Promise.resolve({
          series_count: code === '' ? 500 : 0,
          available_codes: code === '' ? { COUNTRY: { count: 2, codes: ['USA', 'GBR'] } } : {},
          time_period_start: null,
          time_period_end: null,
        }),
      );

      const response = await query('tur.ngdp_rpch.a');
      const error = contractError(response);

      expect(error.data).toMatchObject({ reason: 'no_data', key: 'TUR.NGDP_RPCH.A' });
      expect(error.message).toContain("'TUR' has 0 series in 'WEO'");
      expect(error.message).toContain('USA, GBR');
      expect(mockSvc.fetchAvailabilityConstraint.mock.calls.map((call) => call[1])).toEqual([
        'TUR',
        '',
      ]);
    });

    it('keeps the empty-dataflow diagnosis for a valid code when the dataflow publishes nothing', async () => {
      mockSvc.fetchData.mockResolvedValue({ ...MOCK_QUERY_RESULT, observations: [] });
      mockSvc.fetchAvailabilityConstraint.mockResolvedValue({
        series_count: 0,
        available_codes: {},
        time_period_start: null,
        time_period_end: null,
      });

      const error = contractError(await query('TUR.NGDP_RPCH.A'));

      expect(error.data?.reason).toBe('no_data');
      expect(error.message).toContain("Dataflow 'WEO' publishes no series at all");
    });

    it('declares both new reasons as warning-severity ValidationErrors with actionable recovery', () => {
      for (const reason of ['invalid_key_code', 'wildcard_in_code_list']) {
        const entry = imfQueryDataset.errors?.find((e) => e.reason === reason);
        expect(entry).toMatchObject({
          code: JsonRpcErrorCode.ValidationError,
          severity: 'warning',
        });
        expect(entry?.recovery.split(/\s+/).length).toBeGreaterThanOrEqual(5);
      }
    });
  });

  describe('#56 staged tables declare their column types', () => {
    const STAGED_COLUMNS = {
      dataflow_id: 'VARCHAR',
      series_key: 'VARCHAR',
      time_period: 'VARCHAR',
      value: 'DOUBLE',
      status: 'VARCHAR',
      unit: 'VARCHAR',
      scale: 'VARCHAR',
      decimals: 'INTEGER',
    };
    const GTM = 'GTM.XDC_USD.PA_RT.M';

    /** Consecutive monthly labels from 1971-M01, so rows stage in time order. */
    const monthly = (values: Array<{ value: number | null; status: string | null }>) =>
      values.map(({ value, status }, index) => ({
        series_key: GTM,
        time_period: `${1971 + Math.floor(index / 12)}-M${String((index % 12) + 1).padStart(2, '0')}`,
        value,
        status,
      }));

    /** Fractional exchange rates, including the three the whole-number sniff truncated to 0, 3 and 7. */
    const FRACTIONAL = [
      0.999999999,
      3.3913,
      7.62418,
      ...Array.from({ length: 27 }, (_, i) => 7.5 + (i + 1) / 64),
    ].map((value) => ({ value, status: null }));

    let canvas: DataCanvas;

    beforeEach(() => {
      const provider = new DuckdbProvider({
        defaultRowLimit: 10_000,
        exportRootPath: '.canvas-exports',
        memoryLimitMb: 128,
        schemaSniffRows: 100,
      });
      canvas = new DataCanvas(
        provider,
        new CanvasRegistry(provider, {
          absoluteCapMs: 60_000,
          maxCanvasesPerTenant: 10,
          sweeperIntervalMs: 0,
          ttlMs: 60_000,
        }),
      );
      (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue(canvas);
    });

    afterEach(async () => {
      await canvas.shutdown(createMockContext({ tenantId: 'test' }));
    });

    /** Stage `rows` through the tool on a real DuckDB canvas, then read the table back. */
    const stageAndRead = async (rows: ReturnType<typeof monthly>) => {
      serveErRows(rows);
      const response = await runToolContract(
        imfQueryDataset,
        { dataflow_id: 'ER', key: GTM, output_mode: 'canvas' },
        { context: { tenantId: 'test' } },
      );
      const structured = response.structuredContent as {
        canvas_id: string;
        table_name: string;
        observation_count: number;
        observations: Array<{ time_period: string; value: number | null }>;
      };
      const instance = await canvas.acquire(
        structured.canvas_id,
        createMockContext({ tenantId: 'test' }),
      );
      const [table] = await instance.describe();
      const { rows: staged } = await instance.query(
        `SELECT time_period, value, status, decimals FROM ${structured.table_name} ORDER BY time_period`,
      );
      return {
        structured,
        columns: Object.fromEntries(table!.columns.map((column) => [column.name, column.type])),
        staged,
      };
    };

    it('passes registerTable an explicit schema naming every staged row field', async () => {
      const registerTable = vi.fn().mockResolvedValue({
        tableName: 'imf_schema',
        rowCount: MOCK_OBSERVATIONS.length,
        columns: [],
      });
      (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-schema', registerTable }),
      });

      await imfQueryDataset.handler(
        imfQueryDataset.input.parse({
          dataflow_id: 'WEO',
          key: 'USA.NGDP_RPCH.A',
          output_mode: 'canvas',
        }),
        createMockContext({ tenantId: 'test', errors: imfQueryDataset.errors }),
      );

      const [, rows, options] = registerTable.mock.calls[0] as [
        string,
        Array<Record<string, unknown>>,
        { schema?: Array<{ name: string; type: string }> },
      ];
      expect(options.schema).toEqual(
        Object.entries(STAGED_COLUMNS).map(([name, type]) => ({ name, type })),
      );
      expect(Object.keys(rows[0]!)).toEqual(Object.keys(STAGED_COLUMNS));
    });

    it('keeps fractional values exact after 100+ leading whole numbers', async () => {
      const rows = monthly([
        ...Array.from({ length: 120 }, () => ({ value: 1, status: null })),
        ...FRACTIONAL,
      ]);

      const { structured, columns, staged } = await stageAndRead(rows);

      expect(columns).toEqual(STAGED_COLUMNS);
      expect(structured.observation_count).toBe(rows.length);
      expect(staged.map((row) => row.value)).toEqual(rows.map((row) => row.value));
      expect(staged.map((row) => row.value)).toEqual(
        structured.observations.map((obs) => obs.value),
      );
      expect(staged.map((row) => row.decimals)).toEqual(Array(rows.length).fill(3));
    });

    it('reads numbers back as numbers after 100+ leading null values kept for their status', async () => {
      const rows = monthly([
        ...Array.from({ length: 110 }, () => ({ value: null, status: 'T' })),
        ...FRACTIONAL,
      ]);

      const { columns, staged } = await stageAndRead(rows);

      expect(columns.value).toBe('DOUBLE');
      expect(staged).toHaveLength(rows.length);
      expect(staged.slice(0, 110).every((row) => row.value === null && row.status === 'T')).toBe(
        true,
      );
      expect(staged.slice(110).map((row) => row.value)).toEqual(FRACTIONAL.map((row) => row.value));
      expect(staged.slice(110).every((row) => typeof row.value === 'number')).toBe(true);
    });
  });

  describe('#53 last_n_observations', () => {
    const USA = 'USA.CPI._T.IX.M';
    const JAM = 'JAM.CPI._T.IX.M';
    const SLB = 'SLB.CPI._T.IX.M';
    const row = (series_key: string, time_period: string, value: number | null) => ({
      series_key,
      time_period,
      value,
      status: null,
    });

    /**
     * The tail of `USA+JAM+SLB.CPI._T.IX.M` as the portal ships it, time-sorted
     * across series the way the service returns rows. JAM and SLB each end in a
     * null padding cell, and `lastNObservations` counts that cell toward N.
     */
    const CPI_TAIL = [
      row(SLB, '2026-M02', 135.2557),
      row(SLB, '2026-M03', 130.9734),
      row(SLB, '2026-M04', null),
      row(JAM, '2026-M06', 150.9),
      row(USA, '2026-M06', 153.150000802548),
      row(JAM, '2026-M07', 152.7),
      row(USA, '2026-M07', 153.1344084418875),
      row(JAM, '2026-M08', null),
      row(USA, '2026-M08', 153.6214404131058),
    ];
    /** What `?lastNObservations=1` returns for the same key: the padding cells are JAM's and SLB's last. */
    const CPI_FORWARDED_N1 = [
      row(SLB, '2026-M04', null),
      row(JAM, '2026-M08', null),
      row(USA, '2026-M08', 153.6214404131058),
    ];

    /** `WEO USA.NGDP_RPCH.A`'s tail: the latest period is a projection year. */
    const WEO_TAIL = ['2018', '2019', '2020', '2021', '2029', '2030', '2031'].map((year, i) =>
      row('USA.NGDP_RPCH.A', year, i + 0.5),
    );

    /** `CPI`'s five-position key shape, codelists empty so any code passes unchecked. */
    const CPI_STRUCTURE = {
      ...MOCK_STRUCTURE,
      dataflowId: 'CPI',
      keyFormat: 'COUNTRY.INDEX_TYPE.COICOP_1999.TYPE_OF_TRANSFORMATION.FREQUENCY',
      dimensions: [
        'COUNTRY',
        'INDEX_TYPE',
        'COICOP_1999',
        'TYPE_OF_TRANSFORMATION',
        'FREQUENCY',
      ].map((id, position) => ({ id, name: id, position, codelist: [] })),
    };

    beforeEach(() => {
      mockSvc.fetchDataflowStructure.mockImplementation((dataflowId: string) =>
        Promise.resolve(dataflowId === 'CPI' ? CPI_STRUCTURE : MOCK_STRUCTURE),
      );
    });

    const serveRows = (...responses: Array<ReturnType<typeof row>[]>) => {
      for (const observations of responses) {
        mockSvc.fetchData.mockResolvedValueOnce({ ...MOCK_QUERY_RESULT, observations });
      }
    };
    /** The `lastNObservations` argument of each data request, in call order. */
    const forwardedN = () => mockSvc.fetchData.mock.calls.map((call) => call[8]);
    const contentText = (response: Awaited<ReturnType<typeof runToolContract>>) =>
      (response.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n');
    const periods = (response: Awaited<ReturnType<typeof runToolContract>>) =>
      (
        response.structuredContent as {
          observations: Array<{ series_key: string; time_period: string }>;
        }
      ).observations.map((obs) => `${obs.series_key.slice(0, 3)} ${obs.time_period}`);

    describe('input bounds', () => {
      it('accepts 1 and 10,000, and treats a blank as unset', () => {
        const base = { dataflow_id: 'CPI', key: USA };
        expect(
          imfQueryDataset.input.parse({ ...base, last_n_observations: 1 }).last_n_observations,
        ).toBe(1);
        expect(
          imfQueryDataset.input.parse({ ...base, last_n_observations: 10_000 }).last_n_observations,
        ).toBe(10_000);
        expect(
          imfQueryDataset.input.parse({ ...base, last_n_observations: '' }).last_n_observations,
        ).toBeUndefined();
      });

      it.each([
        [0, 'too_small'],
        [-1, 'too_small'],
        [1.5, 'invalid_type'],
        [10_001, 'too_big'],
        [true, 'invalid_type'],
      ])('rejects %s as %s before any upstream call', async (value, issueCode) => {
        const error = contractError(
          await runToolContract(imfQueryDataset, {
            dataflow_id: 'CPI',
            key: USA,
            last_n_observations: value as number,
          }),
        );

        expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
        expect(error.data?.issues).toEqual([
          expect.objectContaining({ code: issueCode, path: ['last_n_observations'] }),
        ]);
        expect(mockSvc.findDataflow).not.toHaveBeenCalled();
        expect(mockSvc.fetchData).not.toHaveBeenCalled();
      });
    });

    it('leaves the request and the result unchanged when absent', async () => {
      serveRows(CPI_TAIL);

      const response = await runToolContract(imfQueryDataset, { dataflow_id: 'CPI', key: USA });

      expect(forwardedN()).toEqual([undefined]);
      expect(response.structuredContent).not.toHaveProperty('last_n_observations');
      expect(contentText(response)).not.toContain('Last observations');
      expect((response.structuredContent as { observation_count: number }).observation_count).toBe(
        7,
      );
    });

    it('forwards N with no period bound and returns each series’ last N on both channels', async () => {
      serveRows([row(JAM, '2026-M07', 152.7), row(USA, '2026-M08', 153.6214404131058)]);

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'CPI',
        key: 'USA+JAM.CPI._T.IX.M',
        last_n_observations: 1,
      });
      const structured = response.structuredContent as {
        last_n_observations?: number;
        observation_count: number;
      };

      expect(forwardedN()).toEqual([1]);
      expect(periods(response)).toEqual(['JAM 2026-M07', 'USA 2026-M08']);
      expect(structured.last_n_observations).toBe(1);
      expect(structured.observation_count).toBe(2);
      expect(contentText(response)).toContain('**Last observations:** 1 per series');
      expect(contentText(response)).toContain(
        '| USA.CPI._T.IX.M | 2026-M08 | 153.6214404131058 | — |',
      );
    });

    it('re-fetches without N when padding fills a series’ last N, so JAM and SLB are not lost', async () => {
      serveRows(CPI_FORWARDED_N1, CPI_TAIL);

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'CPI',
        key: 'USA+JAM+SLB.CPI._T.IX.M',
        last_n_observations: 1,
      });

      expect(forwardedN()).toEqual([1, undefined]);
      expect(periods(response)).toEqual(['SLB 2026-M03', 'JAM 2026-M07', 'USA 2026-M08']);
      expect((response.structuredContent as { observation_count: number }).observation_count).toBe(
        3,
      );
      expect(contentText(response)).toContain('| JAM.CPI._T.IX.M | 2026-M07 | 152.7 | — |');
      expect(contentText(response)).toContain('| SLB.CPI._T.IX.M | 2026-M03 | 130.9734 | — |');
    });

    it('selects past the padding at N=2, and returns a short series whole', async () => {
      const forwarded = [
        row(SLB, '2026-M03', 130.9734),
        row(SLB, '2026-M04', null),
        row(JAM, '2026-M07', 152.7),
        row(USA, '2026-M07', 153.1344084418875),
        row(JAM, '2026-M08', null),
        row(USA, '2026-M08', 153.6214404131058),
      ];
      // LCA publishes one real observation after its padding.
      const LCA = 'LCA.CPI._T.IX.M';
      const full = [row(LCA, '2026-M01', null), row(LCA, '2026-M02', 99.1), ...CPI_TAIL];
      serveRows([row(LCA, '2026-M01', null), row(LCA, '2026-M02', 99.1), ...forwarded], full);

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'CPI',
        key: 'USA+JAM+SLB+LCA.CPI._T.IX.M',
        last_n_observations: 2,
      });

      expect(forwardedN()).toEqual([2, undefined]);
      expect(periods(response)).toEqual([
        'LCA 2026-M02',
        'SLB 2026-M02',
        'SLB 2026-M03',
        'JAM 2026-M06',
        'JAM 2026-M07',
        'USA 2026-M07',
        'USA 2026-M08',
      ]);
    });

    it('keeps the forwarded rows when the padding drop removes nothing', async () => {
      serveRows(CPI_TAIL.filter((obs) => obs.value !== null && obs.time_period >= '2026-M03'));

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'CPI',
        key: 'USA+JAM+SLB.CPI._T.IX.M',
        last_n_observations: 10_000,
      });

      expect(forwardedN()).toEqual([10_000]);
      expect(periods(response)).toEqual([
        'SLB 2026-M03',
        'JAM 2026-M06',
        'USA 2026-M06',
        'JAM 2026-M07',
        'USA 2026-M07',
        'USA 2026-M08',
      ]);
    });

    it('never forwards N with end_period, and selects the last N inside the window', async () => {
      serveRows(WEO_TAIL);

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'WEO',
        key: 'USA.NGDP_RPCH.A',
        end_period: '2020',
        last_n_observations: 1,
      });

      expect(forwardedN()).toEqual([undefined]);
      expect(periods(response)).toEqual(['USA 2020']);
      expect(response.structuredContent).toMatchObject({
        end_period: '2020',
        last_n_observations: 1,
      });
    });

    it('selects each series’ last N inside a start_period/end_period window', async () => {
      serveRows(CPI_TAIL);

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'CPI',
        key: 'USA+JAM+SLB.CPI._T.IX.M',
        start_period: '2026-03',
        end_period: '2026-07',
        last_n_observations: 2,
      });

      expect(forwardedN()).toEqual([undefined]);
      expect(periods(response)).toEqual([
        'SLB 2026-M03',
        'JAM 2026-M06',
        'USA 2026-M06',
        'JAM 2026-M07',
        'USA 2026-M07',
      ]);
    });

    it('reports no_data exactly as without N, including a response that is all padding', async () => {
      const allPadding = [row(JAM, '2026-M08', null)];
      serveRows(allPadding, allPadding, allPadding);

      const withN = contractError(
        await runToolContract(imfQueryDataset, {
          dataflow_id: 'CPI',
          key: JAM,
          last_n_observations: 1,
        }),
      );
      const without = contractError(
        await runToolContract(imfQueryDataset, { dataflow_id: 'CPI', key: JAM }),
      );

      expect(forwardedN()).toEqual([1, undefined, undefined]);
      expect(withN.data).toMatchObject({ reason: 'no_data' });
      expect(withN.message).toBe(without.message);
    });

    it('reports no_data_in_range with the same range as without N', async () => {
      serveRows(WEO_TAIL, WEO_TAIL);
      const input = { dataflow_id: 'WEO', key: 'USA.NGDP_RPCH.A', end_period: '2010' };

      const withN = contractError(
        await runToolContract(imfQueryDataset, { ...input, last_n_observations: 1 }),
      );
      const without = contractError(await runToolContract(imfQueryDataset, input));

      expect(forwardedN()).toEqual([undefined, undefined]);
      expect(withN.data).toMatchObject({
        reason: 'no_data_in_range',
        available_range: { first: '2018', last: '2031' },
        excluded_observation_count: 7,
      });
      expect(withN.message).toBe(without.message);
    });

    it('stages only the selected observations with output_mode canvas', async () => {
      let staged: Array<Record<string, unknown>> = [];
      const registerTable = vi.fn(
        async (_tableName: string, rows: Array<Record<string, unknown>>) => {
          staged = rows;
          return { tableName: 'imf_last_n', rowCount: rows.length, columns: [] };
        },
      );
      (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-last-n', registerTable }),
      });
      serveRows(CPI_FORWARDED_N1, CPI_TAIL);

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'CPI',
        key: 'USA+JAM+SLB.CPI._T.IX.M',
        last_n_observations: 1,
        output_mode: 'canvas',
      });

      expect(response.structuredContent).toMatchObject({
        staged: true,
        truncated: false,
        observation_count: 3,
        last_n_observations: 1,
      });
      expect(staged.map((stagedRow) => [stagedRow.series_key, stagedRow.time_period])).toEqual([
        [SLB, '2026-M03'],
        [JAM, '2026-M07'],
        [USA, '2026-M08'],
      ]);
      expect(contentText(response)).toContain('**Last observations:** 1 per series');
    });

    it('stages only the selected observations when an over-budget result spills', async () => {
      let staged: Array<Record<string, unknown>> = [];
      const registerTable = vi.fn(
        async (_tableName: string, rows: Array<Record<string, unknown>>) => {
          staged = rows;
          return { tableName: 'imf_last_n', rowCount: rows.length, columns: [] };
        },
      );
      (getCanvas as ReturnType<typeof vi.fn>).mockReturnValue({
        acquire: vi.fn().mockResolvedValue({ canvasId: 'canvas-last-n', registerTable }),
      });
      /** Two daily series of 2,000 days each; N=1,500 keeps 3,000 rows, well over the inline budget. */
      const daily = (seriesKey: string) =>
        Array.from({ length: 2000 }, (_, i) =>
          row(seriesKey, new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10), i),
        );
      serveRows(
        [...daily('USA.X.D'), ...daily('GBR.X.D')].sort((a, b) =>
          a.time_period.localeCompare(b.time_period),
        ),
      );

      const response = await runToolContract(imfQueryDataset, {
        dataflow_id: 'WEO',
        key: 'USA+GBR.X.D',
        start_period: '2000-01-01',
        last_n_observations: 1500,
      });

      expect(response.structuredContent).toMatchObject({
        staged: true,
        truncated: true,
        observation_count: 3000,
      });
      expect(staged).toHaveLength(3000);
      for (const seriesKey of ['USA.X.D', 'GBR.X.D']) {
        const values = staged.filter((r) => r.series_key === seriesKey).map((r) => r.value);
        expect(values).toHaveLength(1500);
        expect(values[0]).toBe(500);
        expect(values.at(-1)).toBe(1999);
      }
    });
  });
});
