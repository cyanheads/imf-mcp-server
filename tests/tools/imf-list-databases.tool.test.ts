/**
 * @fileoverview Tests for the imf_list_databases tool — vintage exclusion, the
 * substring filter, the error contract, and (#29) the limit/offset page plus
 * description shortening. The paging cases assert what a caller receives — page
 * contents, the reported match total, the notice naming the next offset — rather
 * than the slice arithmetic, and pin that `filter` still searches the full
 * description the listing no longer returns in full.
 * @module tests/tools/imf-list-databases.tool.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, getEnrichment, runToolContract } from '@cyanheads/mcp-ts-core/testing';
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

  it('#37 declares external-world access at the tool-definition boundary', () => {
    expect(imfListDatabases.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
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

  it('#46 normalizes padded filters and keeps case-insensitive ID, name, and full-description matching', async () => {
    const longDescription = `${'x'.repeat(250)} Sovereign Arrears`;
    mockSvc.fetchDataflows.mockResolvedValue([
      { id: 'WEO', agencyId: 'IMF.RES', version: '9.0.0', name: 'World Economic Outlook' },
      { id: 'BOP', agencyId: 'IMF.STA', version: '1.0.0', name: 'Balance of Payments' },
      {
        id: 'ARR',
        agencyId: 'IMF.STA',
        version: '1.0.0',
        name: 'Arrears',
        description: longDescription,
      },
    ]);

    for (const [filter, id] of [
      ['  weo  ', 'WEO'],
      ['  BALANCE  ', 'BOP'],
      ['  sovereign arrears  ', 'ARR'],
    ] as const) {
      const parsed = imfListDatabases.input.parse({ filter });
      expect(parsed.filter).toBe(filter.trim());
      const result = await imfListDatabases.handler(
        parsed,
        createMockContext({ tenantId: 'test', errors: imfListDatabases.errors }),
      );
      expect(result.dataflows.map((dataflow) => dataflow.id)).toEqual([id]);
    }
  });

  it('#46 uses normalized filter text in the content[] enrichment trailer', async () => {
    const response = await runToolContract(imfListDatabases, { filter: '  no such dataflow  ' });
    const text = (response.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(text).toContain('No dataflows matched filter "no such dataflow"');
    expect(text).not.toContain('  no such dataflow  ');
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

  it('empty-match notice with vintages excluded counts non-vintage dataflows and offers include_vintages', async () => {
    const response = await runToolContract(imfListDatabases, { filter: 'xyznonexistent' });
    const notice = (response.structuredContent as { notice?: string }).notice;
    const text = (response.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    for (const surface of [notice, text]) {
      expect(surface).toContain(
        'omit filter to browse all 3 non-vintage dataflows. Set include_vintages=true to include historical snapshot entries.',
      );
    }
  });

  it('empty-match notice with include_vintages=true counts every dataflow and does not re-offer the flag', async () => {
    const response = await runToolContract(imfListDatabases, {
      filter: 'xyznonexistent',
      include_vintages: true,
    });
    const notice = (response.structuredContent as { notice?: string }).notice;
    const text = (response.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    for (const surface of [notice, text]) {
      expect(surface).toContain('No dataflows matched filter "xyznonexistent"');
      expect(surface).toContain(
        'omit filter to browse all 4 dataflows, historical snapshot entries included.',
      );
      expect(surface).not.toContain('non-vintage');
      expect(surface).not.toContain('Set include_vintages=true');
    }
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

  it('#29/#65 accepts a limit up to the 1,000 hard ceiling and rejects one past it', () => {
    expect(imfListDatabases.input.parse({ limit: 500 }).limit).toBe(500);
    expect(imfListDatabases.input.parse({ limit: 1_000 }).limit).toBe(1_000);
    expect(() => imfListDatabases.input.parse({ limit: 1_001 })).toThrow();
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
  // #54: filter matches every word, not one literal substring
  // -------------------------------------------------------------------------

  /** Live catalog entries in catalog order; descriptions are each entry's opening text. */
  const OUTLOOK_CATALOG = [
    {
      id: 'ANEA',
      agencyId: 'IMF.STA',
      version: '6.0.1',
      name: 'National Economic Accounts (NEA), Annual Data',
      description:
        'This dataset presents national, official estimates of annual expenditure-based Gross Domestic Product (GDP), by economy.',
    },
    {
      id: 'QNEA',
      agencyId: 'IMF.STA',
      version: '7.0.0',
      name: 'National Economic Accounts (NEA), Quarterly Data',
      description:
        'This dataset provides a snapshot of the economic activity of various countries on a quarterly basis.',
    },
    {
      id: 'AFRREO',
      agencyId: 'IMF.AFR',
      version: '7.0.0',
      name: 'Sub-Saharan Africa Regional Economic Outlook (AFRREO)',
      description:
        'Data for the REO for sub-Saharan Africa are prepared in conjunction with the semi-annual World Economic Outlook (WEO) exercises, spring and fall.',
    },
    {
      id: 'MCDREO',
      agencyId: 'IMF.MCD',
      version: '8.0.0',
      name: 'Middle East and Central Asia Regional Economic Outlook (MCDREO) ',
      description:
        'The Middle East and Central Asia Department Regional Economic Outlook (MCDREO) provides information on recent economic developments and prospects for 32 countries and territories.',
    },
    {
      id: 'WHDREO',
      agencyId: 'IMF.WHD',
      version: '5.0.0',
      name: 'Western Hemisphere Regional Economic Outlook (WHDREO)',
      description:
        'Data for the Western Hemisphere REO are prepared in conjunction and are consistent with the semi-annual World Economic Outlook (WEO) exercises.',
    },
    {
      id: 'APDREO',
      agencyId: 'IMF.APD',
      version: '6.0.0',
      name: 'Asia and Pacific Regional Economic Outlook (APDREO)',
      description:
        'Data for the REO for Asia and Pacific is prepared in conjunction with the semi-annual World Economic Outlook (WEO) exercises, spring and fall.',
    },
    {
      id: 'WEO',
      agencyId: 'IMF.RES',
      version: '9.0.0',
      name: 'World Economic Outlook (WEO)',
      description:
        'The World Economic Outlook (WEO) database is created during the biannual WEO exercise.',
    },
    {
      id: 'QGDP_WCA',
      agencyId: 'IMF.STA',
      version: '4.0.0',
      name: 'Quarterly Gross Domestic Product (GDP), World and Country Aggregates',
      description:
        'This dataset provides a snapshot of the economic activity of the world and selected country aggregates on a quarterly basis.',
    },
  ];

  const idsFor = async (filter: string) => {
    mockSvc.fetchDataflows.mockResolvedValue(OUTLOOK_CATALOG);
    const ctx = createMockContext({ tenantId: 'test', errors: imfListDatabases.errors });
    const result = await imfListDatabases.handler(imfListDatabases.input.parse({ filter }), ctx);
    return {
      ids: result.dataflows.map((dataflow) => dataflow.id),
      total: result.total_count,
      notice: getEnrichment(ctx).notice as string | undefined,
    };
  };

  it('#54 keeps every match a phrase already had', async () => {
    const { ids } = await idsFor('Regional Economic Outlook');

    expect(ids).toEqual(['AFRREO', 'MCDREO', 'WHDREO', 'APDREO']);
  });

  it('#54 keeps the matches a filter with no whitespace or comma already had', async () => {
    const { ids } = await idsFor('NEA');

    expect(ids).toEqual(['ANEA', 'QNEA']);
  });

  it.each([
    // MCDREO is an outlook that never mentions WEO, so it stays out.
    ['WEO outlook', ['AFRREO', 'WHDREO', 'APDREO', 'WEO']],
    // QGDP_WCA is quarterly and ANEA is NEA, but only QNEA is both.
    ['QNEA quarterly', ['QNEA']],
    ['outlook, WEO', ['AFRREO', 'WHDREO', 'APDREO', 'WEO']],
  ])(
    '#54 keeps a dataflow when every word of %s appears in its ID, name, or description',
    async (filter, expected) => {
      const { ids, total } = await idsFor(filter);

      expect(ids).toEqual(expected);
      expect(total).toBe(expected.length);
    },
  );

  it('#54 carries a multi-word match through structuredContent and content[]', async () => {
    mockSvc.fetchDataflows.mockResolvedValue(OUTLOOK_CATALOG);
    const response = await runToolContract(imfListDatabases, { filter: 'QNEA quarterly' });
    const structured = response.structuredContent as {
      total_count: number;
      notice?: string;
      dataflows: Array<{ id: string }>;
    };
    const text = (response.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(structured.total_count).toBe(1);
    expect(structured.dataflows.map((dataflow) => dataflow.id)).toEqual(['QNEA']);
    expect(structured.notice).toBeUndefined();
    expect(text).toContain('**1 dataflow matched**');
    expect(text).toContain('### QNEA');
    expect(text).not.toContain('### QGDP_WCA');
  });

  it('#54 needs every word — one missing word empties the match and the notice says so', async () => {
    mockSvc.fetchDataflows.mockResolvedValue(OUTLOOK_CATALOG);
    // "WEO" and "outlook" both match; "monthly" matches nothing.
    const response = await runToolContract(imfListDatabases, { filter: 'WEO outlook monthly' });
    const structured = response.structuredContent as {
      total_count: number;
      notice: string;
    };
    const text = (response.content as Array<{ text?: string }>)
      .map((block) => block.text ?? '')
      .join('\n');

    expect(structured.total_count).toBe(0);
    expect(structured.notice).toContain('"WEO outlook monthly"');
    expect(structured.notice).toContain('fewer or shorter words');
    expect(text).toContain('fewer or shorter words');
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

  // -------------------------------------------------------------------------
  // #67: a blank optional input is unset
  // -------------------------------------------------------------------------

  describe('#67 blank optional inputs', () => {
    beforeEach(() => {
      mockSvc.fetchDataflows.mockResolvedValue(catalogOf(103));
    });

    it.each(
      ['filter', 'limit', 'offset', 'include_vintages'].flatMap((field) =>
        ['', '   '].map((blank) => [field, blank]),
      ),
    )('reads %s: %j exactly as if it were omitted', async (field, blank) => {
      const omitted = await runToolContract(imfListDatabases, {});
      const sent = await runToolContract(imfListDatabases, { [field]: blank });

      expect(sent.isError).toBeFalsy();
      expect(sent.structuredContent).toEqual(omitted.structuredContent);
      expect(sent.content).toEqual(omitted.content);
      // The defaults applied: a 50-entry page from offset 0.
      expect(sent.structuredContent).toMatchObject({ returned_count: 50, offset: 0 });
    });

    it('keeps reading limit "50" and offset "50" as numbers', async () => {
      const sent = await runToolContract(imfListDatabases, { limit: '50', offset: '50' });
      const typed = await runToolContract(imfListDatabases, { limit: 50, offset: 50 });

      expect(sent.isError).toBeFalsy();
      expect(sent.structuredContent).toEqual(typed.structuredContent);
    });

    it.each([
      ['limit', '01'],
      ['limit', '1e3'],
      ['offset', '01'],
    ])('still rejects %s %j', async (field, sent) => {
      const response = await runToolContract(imfListDatabases, { [field]: sent });

      expect(response.isError).toBe(true);
      expect(mockSvc.fetchDataflows).not.toHaveBeenCalled();
    });

    it('offers no blank as an input in any field description', () => {
      for (const [field, schema] of Object.entries(imfListDatabases.input.shape)) {
        expect(schema.description ?? '', field).not.toMatch(/blank|empty string|''|""/i);
      }
    });
  });

  // -------------------------------------------------------------------------
  // #65: a limit above the per-call cap serves the cap and says so
  // -------------------------------------------------------------------------

  describe('#65 limit above the per-call cap', () => {
    const textOf = (response: Awaited<ReturnType<typeof runToolContract>>) =>
      (response.content as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n');
    const listAll = async (count: number, args: Record<string, unknown>) => {
      mockSvc.fetchDataflows.mockResolvedValue(catalogOf(count));
      return await runToolContract(imfListDatabases, args);
    };

    it('serves 200 of 224, echoes requested and applied limit, and names the next offset', async () => {
      const response = await listAll(224, { limit: 250, include_vintages: true });
      const structured = response.structuredContent as Record<string, unknown> & {
        dataflows: unknown[];
      };

      expect(response.isError).toBeFalsy();
      expect(structured.dataflows).toHaveLength(200);
      expect(structured).toMatchObject({
        total_count: 224,
        returned_count: 200,
        offset: 0,
        requested_limit: 250,
        applied_limit: 200,
        truncated: true,
        shown: 200,
        cap: 200,
      });
      expect(structured.notice).toBe(
        'limit 250 is above the per-call maximum of 200, so this page holds 200. Showing 1–200 of 224 matching dataflows. Call again with offset=200 for the next page, or narrow with filter.',
      );
      const text = textOf(response);
      expect(text).toContain('**requested_limit:** 250');
      expect(text).toContain('**applied_limit:** 200');
      expect(text).toContain('offset=200');
      expect(text).not.toContain('raise limit');
    });

    it('returns a whole catalog under the cap with the echo and no truncation notice', async () => {
      const response = await listAll(104, { limit: 250 });
      const structured = response.structuredContent as Record<string, unknown>;

      expect(structured).toMatchObject({
        total_count: 104,
        returned_count: 104,
        requested_limit: 250,
        applied_limit: 200,
      });
      expect(structured).not.toHaveProperty('notice');
      expect(structured).not.toHaveProperty('truncated');
    });

    it('reads limit "250" as 250', async () => {
      const sent = await listAll(224, { limit: '250' });
      const typed = await listAll(224, { limit: 250 });

      expect(sent.isError).toBeFalsy();
      expect(sent.structuredContent).toEqual(typed.structuredContent);
    });

    it('echoes from one past the cap, and not at it', async () => {
      const atCap = (await listAll(500, { limit: 200 })).structuredContent as Record<
        string,
        unknown
      >;
      const pastCap = (await listAll(500, { limit: 201 })).structuredContent as Record<
        string,
        unknown
      >;

      expect(atCap).not.toHaveProperty('requested_limit');
      expect(atCap).not.toHaveProperty('applied_limit');
      expect(atCap.notice).toBe(
        'Showing 1–200 of 500 matching dataflows. Call again with offset=200 for the next page, or narrow with filter.',
      );
      expect(pastCap).toMatchObject({
        requested_limit: 201,
        applied_limit: 200,
        returned_count: 200,
      });
    });

    it('keeps a capped page past the end of the catalog on the past-the-end notice', async () => {
      const structured = (await listAll(104, { limit: 500, offset: 300 }))
        .structuredContent as Record<string, unknown>;

      expect(structured).toMatchObject({
        returned_count: 0,
        requested_limit: 500,
        applied_limit: 200,
      });
      expect(structured.notice).toBe(
        'offset 300 is past the end of 104 matching dataflow(s) — request a smaller offset to see them.',
      );
    });

    it('rejects limit 1,001 naming the 1,000 maximum, before any upstream call', async () => {
      const response = await listAll(104, { limit: 1_001 });

      expect(response.isError).toBe(true);
      expect(textOf(response)).toContain('1000');
      expect(mockSvc.fetchDataflows).not.toHaveBeenCalled();
    });

    it.each([0, -1, 1.5])('still rejects limit %s', (limit) => {
      expect(imfListDatabases.input.safeParse({ limit }).success).toBe(false);
    });

    it('advertises 1,000 as the limit maximum', () => {
      expect(z.toJSONSchema(imfListDatabases.input).properties?.limit).toMatchObject({
        maximum: 1_000,
      });
    });
  });
});
