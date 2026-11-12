/**
 * @fileoverview Tests for the period-label helpers: the order observations are
 * returned in (#74) and the availability constraint's time coverage as inclusive
 * days (#72). The order is tabled here once, against literal sequences and the
 * resume property a prefix cut must keep; the service and tool tests prove only
 * that their paths use it. Label parsing itself is covered through
 * imf_query_dataset's period-bound tests, which read every shape the portal emits.
 * @module tests/services/imf-sdmx/time-period.test
 */

import { describe, expect, it } from 'vitest';
import { constraintTimeRange, periodSpan, sortByPeriod } from '@/services/imf-sdmx/time-period.js';

const row = (time_period: string, series_key = 'USA') => ({ series_key, time_period });
const labels = (rows: Array<{ time_period: string }>) => rows.map((r) => r.time_period);

/**
 * The order observations were returned in before #74, by label string. A
 * single-frequency result must keep it exactly.
 */
const byLabelString = <T extends { time_period: string }>(rows: T[]) =>
  rows.toSorted((a, b) => a.time_period.localeCompare(b.time_period));

/** A fixed permutation, so a fixture never arrives in either target order by accident. */
const interleave = <T>(items: T[]) => [
  ...items.filter((_, index) => index % 3 === 2),
  ...items.filter((_, index) => index % 3 === 0).toReversed(),
  ...items.filter((_, index) => index % 3 === 1),
];

/** One year of every label shape the portal serves (A, S, Q, M, D), in span order. */
const YEAR_IN_SPAN_ORDER = [
  '1996-01-01',
  '1996-M01',
  '1996-Q1',
  '1996-S1',
  '1996',
  '1996-01-15',
  '1996-M02',
  '1996-02-29',
  '1996-M03',
  '1996-04-01',
  '1996-M04',
  '1996-Q2',
  '1996-M05',
  '1996-M06',
  '1996-07-01',
  '1996-M07',
  '1996-Q3',
  '1996-S2',
  '1996-M08',
  '1996-M09',
  '1996-M10',
  '1996-Q4',
  '1996-M11',
  '1996-M12',
  '1996-12-31',
  '1997-01-01',
];

describe('sortByPeriod (#74)', () => {
  it.each([
    ['interleaved', interleave(YEAR_IN_SPAN_ORDER)],
    ['reversed', YEAR_IN_SPAN_ORDER.toReversed()],
  ])(
    'orders one year of every shape by first day, then the shorter period (%s fixture)',
    (_name, fixture) => {
      expect(labels(sortByPeriod(fixture.map((label) => row(label))))).toEqual(YEAR_IN_SPAN_ORDER);
    },
  );

  /**
   * Two leap years of every shape, five economies each, as a mixed-frequency key
   * returns them.
   */
  const MIXED = ['DEU', 'FRA', 'GBR', 'JPN', 'USA'].flatMap((economy) =>
    [
      ...YEAR_IN_SPAN_ORDER,
      ...YEAR_IN_SPAN_ORDER.map((label) => label.replace('1997', '2001').replace('1996', '2000')),
    ].map((label) => row(label, economy)),
  );

  it.each([
    ['interleaved', interleave(MIXED)],
    ['reversed', MIXED.toReversed()],
  ])(
    'keeps every row after any cut reachable from the last period before it (%s fixture)',
    (_name, fixture) => {
      const sorted = sortByPeriod(fixture);
      expect(sorted).toHaveLength(MIXED.length);

      /** A cut left out of reach: the row after it that start_period at the cut excludes. */
      const unreachable: string[] = [];
      for (let cut = 1; cut < sorted.length; cut++) {
        const resume = periodSpan(sorted[cut - 1]?.time_period ?? '');
        for (const rest of sorted.slice(cut)) {
          const span = periodSpan(rest.time_period);
          if (resume && span && span.hi < resume.lo) {
            unreachable.push(`${sorted[cut - 1]?.time_period} → ${rest.time_period}`);
          }
        }
      }
      expect(unreachable).toEqual([]);
    },
  );

  it.each([
    ['annual', ['1980', '1999', '2000', '2031']],
    ['semi-annual', ['2024-S1', '2024-S2', '2025-S1', '2025-S2']],
    ['quarterly', ['1996-Q1', '1996-Q2', '1996-Q4', '1997-Q1']],
    ['monthly', ['1996-M01', '1996-M09', '1996-M10', '1996-M12', '1997-M01']],
    ['daily', ['2004-07-07', '2004-07-08', '2004-12-31', '2005-01-01']],
  ])('keeps a single-frequency (%s) result in label-string order', (_name, periods) => {
    const rows = ['USA', 'GBR', 'DEU'].flatMap((economy) =>
      periods.map((period) => row(period, economy)),
    );
    for (const fixture of [interleave(rows), rows.toReversed()]) {
      expect(sortByPeriod(fixture)).toEqual(byLabelString(fixture));
    }
  });

  it('keeps rows that share a label in their relative order', () => {
    const fixture = [
      row('1996-Q1', 'JPN'),
      row('1996', 'USA'),
      row('1996-Q1', 'DEU'),
      row('1996', 'FRA'),
    ];

    expect(sortByPeriod(fixture).map((r) => `${r.series_key} ${r.time_period}`)).toEqual([
      'JPN 1996-Q1',
      'DEU 1996-Q1',
      'USA 1996',
      'FRA 1996',
    ]);
  });

  it('orders labels naming the same days by string', () => {
    const fixture = ['1996-M1', '1996-01', '1996-M01'].map((label) => row(label));

    expect(labels(sortByPeriod(fixture))).toEqual(['1996-01', '1996-M01', '1996-M1']);
  });

  it('sorts a label periodSpan cannot read after every label it can, by string among themselves', () => {
    const fixture = ['bogus', '2020-W05', '2030', '1995-W01', '1990-M01'].map((label) =>
      row(label),
    );

    expect(labels(sortByPeriod(fixture))).toEqual([
      '1990-M01',
      '2030',
      '1995-W01',
      '2020-W05',
      'bogus',
    ]);
  });

  it('returns an empty result for no rows', () => {
    expect(sortByPeriod([])).toEqual([]);
  });
});

describe('constraintTimeRange (#72)', () => {
  it.each([
    ['annual (WEO)', '2032-01-01', '2031-12-31'],
    ['monthly and quarterly (CPI)', '2026-10-01', '2026-09-30'],
    ['daily (CCI)', '2025-02-19', '2025-02-18'],
    ['a leap year', '2024-03-01', '2024-02-29'],
    ['a common year', '2023-03-01', '2023-02-28'],
    ['a century leap year', '2000-03-01', '2000-02-29'],
    ['a century common year', '1900-03-01', '1900-02-28'],
  ])('moves an exclusive %s end back to the last day with data', (_name, end, last) => {
    expect(constraintTimeRange('1980-01-01', end)).toEqual({
      time_period_start: '1980-01-01',
      time_period_end: last,
    });
  });

  it('keeps the start as the first day with data', () => {
    expect(constraintTimeRange('1955-01-01', undefined).time_period_start).toBe('1955-01-01');
  });

  it('gives null for an absent annotation', () => {
    expect(constraintTimeRange(undefined, undefined)).toEqual({
      time_period_start: null,
      time_period_end: null,
    });
  });

  it.each(['2032', '2032-01', '2032-M01', '2032-02-30', '2032-13-01', '2032-01-01T00:00:00', ''])(
    'gives null for a bound that is not a calendar date (%j)',
    (text) => {
      expect(constraintTimeRange(text, text)).toEqual({
        time_period_start: null,
        time_period_end: null,
      });
    },
  );

  it('reads each bound on its own', () => {
    expect(constraintTimeRange('1980', '2032-01-01')).toEqual({
      time_period_start: null,
      time_period_end: '2031-12-31',
    });
  });
});
