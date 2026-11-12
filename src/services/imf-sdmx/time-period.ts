/**
 * @fileoverview Period labels as the dates they name. A label resolves to the
 * inclusive span of days it covers, which backs period-range filtering and the
 * order observations are returned in, and the availability constraint's
 * half-open time coverage is read here as its first and last days with data.
 * @module services/imf-sdmx/time-period
 */

import type { AvailabilityResult } from './types.js';

/** The inclusive span of dates a period label names. */
export interface PeriodSpan {
  /** Last date of the span, as a date key. */
  hi: number;
  /** First date of the span, as a date key. */
  lo: number;
}

/**
 * A calendar date as the comparable integer `YYYYMMDD`. Ordering is the only
 * operation period comparison needs, so the closing edge of a month, quarter,
 * half-year, or year can be day 31 without consulting the calendar: no real
 * date within that month sorts above it, and none in the next month sorts below.
 */
function dateKey(year: number, month: number, day: number): number {
  return year * 10_000 + month * 100 + day;
}

/** Day number closing any month-or-coarser span, and the largest a date may name. */
const LAST_DAY = 31;

/** Milliseconds in one UTC day, which has no daylight-saving shift. */
const DAY_MS = 86_400_000;

/**
 * A `YYYY-MM-DD` label as UTC midnight of that day, or null when the label has
 * another shape or names no calendar day (`2023-02-30`).
 */
function calendarDay(label: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(label);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? date
    : null;
}

/** A UTC date as `YYYY-MM-DD`. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Resolve a period label to the span of dates it names.
 *
 * A period is an interval, not a point: `2023` names January–December 2023 and
 * `2023-Q1` names January–March. Comparing labels as strings instead conflates
 * the two ends of that interval, which is what made `end_period: "2023"` reject
 * `2023-M01` while `start_period: "2023"` admitted it.
 *
 * Recognized labels — every shape api.imf.org emits, since a label the parser
 * does not know is a label the range filter cannot apply:
 *   Annual:       `YYYY`         → January–December of that year
 *   Semi-annual:  `YYYY-SN`      → the half-year's six months (PIP)
 *   Quarterly:    `YYYY-QN`      → the quarter's three months
 *   Monthly:      `YYYY-MM`      → that month (input format)
 *   Monthly:      `YYYY-MNN`     → that month (upstream format, e.g. `1956-M01`)
 *   Daily:        `YYYY-MM-DD`   → that day (IRFCL, CCI)
 *
 * Returns null for anything else; callers decide whether null is fatal (input
 * validation) or a pass-through (per-observation filtering).
 */
export function periodSpan(period: string): PeriodSpan | null {
  const annual = /^(\d{4})$/.exec(period);
  if (annual) {
    const year = Number(annual[1]);
    return { lo: dateKey(year, 1, 1), hi: dateKey(year, 12, LAST_DAY) };
  }

  const semiAnnual = /^(\d{4})-S([12])$/.exec(period);
  if (semiAnnual) {
    const year = Number(semiAnnual[1]);
    const half = Number(semiAnnual[2]);
    return { lo: dateKey(year, half * 6 - 5, 1), hi: dateKey(year, half * 6, LAST_DAY) };
  }

  const quarterly = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarterly) {
    const year = Number(quarterly[1]);
    const quarter = Number(quarterly[2]);
    return { lo: dateKey(year, quarter * 3 - 2, 1), hi: dateKey(year, quarter * 3, LAST_DAY) };
  }

  // A daily-shaped label naming no calendar day matches none of the shapes below.
  const day = calendarDay(period);
  if (day) {
    const key = dateKey(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate());
    return { lo: key, hi: key };
  }

  // Monthly, in the input format (YYYY-MM) or the upstream one (YYYY-MNN).
  const monthly = /^(\d{4})-(\d{2})$/.exec(period) ?? /^(\d{4})-M(\d{1,2})$/.exec(period);
  if (monthly) {
    const month = Number(monthly[2]);
    if (month < 1 || month > 12) return null;
    const year = Number(monthly[1]);
    return { lo: dateKey(year, month, 1), hi: dateKey(year, month, LAST_DAY) };
  }

  return null;
}

/**
 * Rows ordered by the dates their periods span: the earliest first day first,
 * and on a shared first day the shorter period first, so one year runs
 * `1996-01-01, 1996-M01, 1996-Q1, 1996-S1, 1996, 1996-01-15, 1996-M02 …`.
 *
 * Ordering by label string put every month of a year before its quarters, so a
 * prefix cut at `1996-M08` left `1996-Q1` and `1996-Q2` after the cut, where
 * `start_period: "1996-M08"` excludes them. In span order every row after a cut
 * starts on or after the first day of the last row before it, so `start_period`
 * set to that row's period reaches all of them.
 *
 * Within one label shape span order is label order, so a single-frequency
 * result keeps the order string comparison gave it. Labels naming the same days
 * compare as strings, and a label periodSpan() cannot read sorts after every
 * label it can, by string among themselves. Rows sharing a label keep their
 * relative order. Each distinct label is parsed once, never per comparison.
 */
export function sortByPeriod<T extends { time_period: string }>(rows: readonly T[]): T[] {
  const byLabel = new Map<string, T[]>();
  for (const row of rows) {
    const group = byLabel.get(row.time_period);
    if (group) group.push(row);
    else byLabel.set(row.time_period, [row]);
  }
  const groups = [...byLabel].map(([label, members]) => ({
    label,
    members,
    span: periodSpan(label),
  }));
  groups.sort((a, b) => {
    if (a.span && b.span) {
      return a.span.lo - b.span.lo || a.span.hi - b.span.hi || a.label.localeCompare(b.label);
    }
    if (a.span) return -1;
    if (b.span) return 1;
    return a.label.localeCompare(b.label);
  });
  return groups.flatMap((group) => group.members);
}

/**
 * The availability constraint's time coverage as the first and last days with
 * data. The portal publishes it as a half-open interval: `time_period_start`
 * is the first day of the earliest period and `time_period_end` the day after
 * the latest one ends (WEO: `1980-01-01` and `2032-01-01` for 1980–2031), so
 * the end moves back one day. Both stay `YYYY-MM-DD` dates rather than period
 * labels, since one constraint spans every frequency a dataflow publishes, and
 * a date is already an accepted `start_period`/`end_period`. An annotation that
 * is absent or names no calendar day gives null.
 */
export function constraintTimeRange(
  start: string | undefined,
  end: string | undefined,
): Pick<AvailabilityResult, 'time_period_start' | 'time_period_end'> {
  const firstDay = start === undefined ? null : calendarDay(start);
  const dayAfterLast = end === undefined ? null : calendarDay(end);
  return {
    time_period_start: firstDay ? isoDay(firstDay) : null,
    time_period_end: dayAfterLast ? isoDay(new Date(dayAfterLast.getTime() - DAY_MS)) : null,
  };
}
