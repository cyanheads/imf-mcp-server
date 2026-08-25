/**
 * @fileoverview Tests for the imf_list_databases tool — vintage exclusion, the
 * substring filter, the error contract, and (#29) the limit/offset page plus
 * description shortening. The paging cases assert what a caller receives — page
 * contents, the reported match total, the notice naming the next offset — rather
 * than the slice arithmetic, and pin that `filter` still searches the full
 * description the listing no longer returns in full.
 * @module tests/tools/imf-list-databases.tool.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment } from '@cyanheads/mcp-ts-core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { captureMcpError } from '../helpers/errors.js';

vi.mock('@/services/imf-sdmx/imf-sdmx-service.js', () => ({
  getImfSdmxService: vi.fn(),
}));

import { imfListDatabases } from '@/mcp-server/tools/definitions/imf-list-databases.tool.js';
import { getImfSdmxService } from '@/services/imf-sdmx/imf-sdmx-service.js';

const MOCK_DATAFLOWS = [
  { id: 'WEO', agencyId: 'IMF.RES', version: '9.0.0', name: 'World Economic Outlook' },
  { id: 'BOP', agencyId: 'IMF.STA', version: '1.0.0', name: 'Balance of Payments' },
  {
    id: 'WEO_2025_OCT_VINTAGE',
    agencyId: 'IMF.RES',
    version: '1.0.0',
    name: 'WEO Oct 2025 Vintage',
  },
  {
    id: 'CPI',
    agencyId: 'IMF.STA',
    version: '2.0.0',
    name: 'Consumer Price Index',
    description: 'Price indices',
  },
];

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

describe('imfListDatabases', () => {
  let mockSvc: { fetchDataflows: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockSvc = { fetchDataflows: vi.fn().mockResolvedValue(MOCK_DATAFLOWS) };
    (getImfSdmxService as ReturnType<typeof vi.fn>).mockReturnValue(mockSvc);
  });

  it('returns all non-vintage dataflows by default', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({});
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(3);
    expect(result.dataflows.map((d) => d.id)).toEqual(['WEO', 'BOP', 'CPI']);
  });

  it('includes vintage dataflows when include_vintages=true', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({ include_vintages: true });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(4);
    expect(result.dataflows.some((d) => d.id === 'WEO_2025_OCT_VINTAGE')).toBe(true);
  });

  it('filters by name substring (case-insensitive)', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({ filter: 'balance' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(1);
    expect(result.dataflows[0]!.id).toBe('BOP');
  });

  it('filters by description substring', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({ filter: 'price indices' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(1);
    expect(result.dataflows[0]!.id).toBe('CPI');
  });

  it('returns empty list when filter matches nothing', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({ filter: 'xyznonexistent' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(0);
    expect(result.dataflows).toHaveLength(0);
  });

  it('enriches notice when filter matches nothing', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({ filter: 'xyznonexistent' });
    await imfListDatabases.handler(input, ctx);

    const notice = getEnrichment(ctx).notice as string | undefined;
    expect(notice).toBeDefined();
    expect(notice).toContain('xyznonexistent');
    expect(notice).toContain('non-vintage');
  });

  it('does not enrich notice when filter matches results', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({ filter: 'balance' });
    await imfListDatabases.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('does not enrich notice when no filter is provided', async () => {
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({});
    await imfListDatabases.handler(input, ctx);

    expect(getEnrichment(ctx).notice).toBeUndefined();
  });

  it('formats output with agency and name info', () => {
    const output = {
      dataflows: [
        { id: 'WEO', agency_id: 'IMF.RES', version: '9.0.0', name: 'World Economic Outlook' },
      ],
      total_count: 1,
      returned_count: 1,
      offset: 0,
    };
    const blocks = imfListDatabases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('WEO');
    expect(text).toContain('IMF.RES');
    expect(text).toContain('World Economic Outlook');
    expect(text).toContain('9.0.0');
  });

  it('formats optional description when present', () => {
    const output = {
      dataflows: [
        {
          id: 'CPI',
          agency_id: 'IMF.STA',
          version: '2.0.0',
          name: 'Consumer Price Index',
          description: 'Price indices for 90+ countries',
        },
      ],
      total_count: 1,
      returned_count: 1,
      offset: 0,
    };
    const blocks = imfListDatabases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).toContain('Price indices for 90+ countries');
  });

  it('does not render notice in format output (notice is enrichment)', () => {
    // notice lives in the enrichment block — the framework mirrors it into the
    // content[] trailer, so format() must not render it from the domain payload.
    const output = {
      dataflows: [],
      total_count: 0,
      returned_count: 0,
      offset: 0,
    };
    const blocks = imfListDatabases.format!(output);
    const text = (blocks[0] as { text: string }).text;
    expect(text).not.toContain('No dataflows matched');
  });

  // -------------------------------------------------------------------------
  // #9: filter matches descriptions (not just name/ID)
  // -------------------------------------------------------------------------

  it('returns a description-only match when filter matches description but not name or ID', async () => {
    // APDREO has a description about "regional economic outlook" but the ID/name don't match "regional"
    const dataflows = [
      {
        id: 'APDREO',
        agencyId: 'IMF.STA',
        version: '1.0.0',
        name: 'APD Regional Economic Outlook',
        description: 'Asia Pacific regional economic outlook database',
      },
      {
        id: 'WEO',
        agencyId: 'IMF.RES',
        version: '9.0.0',
        name: 'World Economic Outlook',
      },
    ];
    mockSvc.fetchDataflows.mockResolvedValue(dataflows);

    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    // "asia pacific" matches only via description on APDREO (and not WEO)
    const input = imfListDatabases.input.parse({ filter: 'asia pacific' });
    const result = await imfListDatabases.handler(input, ctx);

    expect(result.total_count).toBe(1);
    expect(result.dataflows[0]!.id).toBe('APDREO');
  });

  // -------------------------------------------------------------------------
  // #29: the catalog is paged and descriptions are shortened
  // -------------------------------------------------------------------------

  /** A catalog of `count` dataflows, each with a description of `descriptionChars` characters. */
  const catalogOf = (count: number, descriptionChars = 0) =>
    Array.from({ length: count }, (_, i) => ({
      id: `FLOW_${String(i).padStart(3, '0')}`,
      agencyId: 'IMF.STA',
      version: '1.0.0',
      name: `Dataflow ${i}`,
      ...(descriptionChars > 0 ? { description: 'x'.repeat(descriptionChars) } : {}),
    }));

  const listWith = async (
    dataflows: ReturnType<typeof catalogOf>,
    args: Record<string, unknown> = {},
  ) => {
    mockSvc.fetchDataflows.mockResolvedValue(dataflows);
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const result = await imfListDatabases.handler(imfListDatabases.input.parse(args), ctx);
    return { result, notice: getEnrichment(ctx).notice as string | undefined };
  };

  it('#29 returns one page of a large catalog while reporting the whole match count', async () => {
    const { result } = await listWith(catalogOf(103));

    expect(result.dataflows).toHaveLength(50);
    expect(result.returned_count).toBe(50);
    // total_count is the match count, so a page is never mistaken for the catalog.
    expect(result.total_count).toBe(103);
    expect(result.offset).toBe(0);
  });

  it('#29 pages forward from an offset without repeating or skipping entries', async () => {
    const { result: first } = await listWith(catalogOf(103));
    const { result: second } = await listWith(catalogOf(103), { offset: 50 });

    expect(second.dataflows[0]?.id).toBe('FLOW_050');
    expect(second.returned_count).toBe(50);
    expect(second.offset).toBe(50);
    // No overlap with the first page.
    const firstIds = new Set(first.dataflows.map((df) => df.id));
    expect(second.dataflows.some((df) => firstIds.has(df.id))).toBe(false);
  });

  it('#29 returns the final short page and stops', async () => {
    const { result, notice } = await listWith(catalogOf(103), { offset: 100 });

    expect(result.returned_count).toBe(3);
    expect(result.total_count).toBe(103);
    expect(notice).toBeUndefined();
  });

  it('#29 honors an explicit limit', async () => {
    const { result } = await listWith(catalogOf(103), { limit: 5 });

    expect(result.dataflows).toHaveLength(5);
    expect(result.total_count).toBe(103);
  });

  it('#29 rejects a limit past the ceiling rather than silently capping it', () => {
    expect(() => imfListDatabases.input.parse({ limit: 500 })).toThrow();
    expect(() => imfListDatabases.input.parse({ offset: -1 })).toThrow();
  });

  it('#29 names the next offset when matches remain', async () => {
    mockSvc.fetchDataflows.mockResolvedValue(catalogOf(103));
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    await imfListDatabases.handler(imfListDatabases.input.parse({}), ctx);
    const enrichment = getEnrichment(ctx);

    expect(enrichment.notice).toContain('1–50 of 103');
    expect(enrichment.notice).toContain('offset=50');
    // Disclosed as a capped list, not only in prose.
    expect(enrichment.truncated).toBe(true);
    expect(enrichment.shown).toBe(50);
    expect(enrichment.cap).toBe(50);
  });

  it('#29 stops offering a bigger page once limit is at the ceiling', async () => {
    const { notice: belowCeiling } = await listWith(catalogOf(500), { limit: 50 });
    const { notice: atCeiling } = await listWith(catalogOf(500), { limit: 200 });

    expect(belowCeiling).toContain('raise limit');
    // At 200 the only moves left are the next offset and a narrower filter;
    // naming `limit` there points the caller at the one control that cannot move.
    expect(atCeiling).toContain('offset=200');
    expect(atCeiling).not.toContain('raise limit');
  });

  it('#29 says nothing about paging when the whole match set fits', async () => {
    const { notice } = await listWith(catalogOf(12));

    expect(notice).toBeUndefined();
  });

  it('#29 tells a caller past the end that the offset, not the catalog, is empty', async () => {
    const { result, notice } = await listWith(catalogOf(103), { offset: 500 });

    expect(result.dataflows).toHaveLength(0);
    expect(result.total_count).toBe(103);
    expect(notice).toContain('past the end');
  });

  it('#29 shortens a long description and marks it as cut', async () => {
    const { result } = await listWith(catalogOf(1, 1519));

    // Exactly the documented 200 characters, plus the mark that says text follows.
    expect(result.dataflows[0]?.description).toBe(`${'x'.repeat(200)}…`);
  });

  it('#29 keeps a description of exactly the preview length whole and unmarked', async () => {
    // The boundary is where an off-by-one hides: a description that fits comes
    // back byte-for-byte, with nothing to suggest text was dropped.
    const { result } = await listWith(catalogOf(1, 200));

    expect(result.dataflows[0]?.description).toBe('x'.repeat(200));
  });

  it('#29 cuts a description one character past the preview length', async () => {
    const { result } = await listWith(catalogOf(1, 201));

    expect(result.dataflows[0]?.description).toBe(`${'x'.repeat(200)}…`);
  });

  it('#29 leaves a description within the limit untouched', async () => {
    const short = 'Price indices for 90+ countries';
    mockSvc.fetchDataflows.mockResolvedValue([
      { id: 'CPI', agencyId: 'IMF.STA', version: '2.0.0', name: 'CPI', description: short },
    ]);
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const result = await imfListDatabases.handler(imfListDatabases.input.parse({}), ctx);

    expect(result.dataflows[0]?.description).toBe(short);
  });

  it('#29 still matches filter against the full description, not the shortened one', async () => {
    // The distinguishing word sits past the preview cut — filtering on the
    // shortened text would make it unfindable.
    const description = `${'y'.repeat(400)} sovereign arrears`;
    mockSvc.fetchDataflows.mockResolvedValue([
      { id: 'ARR', agencyId: 'IMF.STA', version: '1.0.0', name: 'Arrears', description },
    ]);
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const result = await imfListDatabases.handler(
      imfListDatabases.input.parse({ filter: 'sovereign arrears' }),
      ctx,
    );

    expect(result.total_count).toBe(1);
    expect(result.dataflows[0]?.description).not.toContain('sovereign arrears');
  });

  it('#29 states the page bounds in content[] so a page never reads as the catalog', () => {
    const output = {
      dataflows: [{ id: 'WEO', agency_id: 'IMF.RES', version: '9.0.0', name: 'WEO' }],
      total_count: 103,
      returned_count: 1,
      offset: 50,
    };
    const text = (imfListDatabases.format!(output)[0] as { text: string }).text;

    // The match total, the page size, and where the page starts — the three
    // facts that separate "one page" from "the whole catalog".
    expect(text).toContain('103 dataflows matched');
    expect(text).toContain('1 in this page');
    expect(text).toContain('offset 50');
  });

  // -------------------------------------------------------------------------
  // #24: dataflow-list failures are declared and controlled
  // -------------------------------------------------------------------------

  it('#24 declares dataflow_list_unavailable so the failure mode is discoverable', () => {
    const entry = imfListDatabases.errors?.find((e) => e.reason === 'dataflow_list_unavailable');
    expect(entry?.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(entry?.retryable).toBe(true);
    expect(entry?.recovery).toBeTruthy();
  });

  it('#24 surfaces the service error unchanged — reason and hint reach the caller', async () => {
    mockSvc.fetchDataflows.mockRejectedValue(dataflowListUnavailable());
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const input = imfListDatabases.input.parse({});

    const err = await captureMcpError(() => imfListDatabases.handler(input, ctx));

    expect(err.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(err.data?.reason).toBe('dataflow_list_unavailable');
    expect(err.data?.recovery).toMatchObject({ hint: expect.stringContaining('Retry') });
    expect(JSON.stringify({ message: err.message, data: err.data })).not.toContain('/structure/');
  });
});
