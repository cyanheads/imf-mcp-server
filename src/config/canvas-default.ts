/**
 * @fileoverview Defaults DataCanvas on. The entry point imports this module
 * first: the dataframe tool gates read CANVAS_PROVIDER_TYPE while their modules
 * load, so the default has to be in place before any of them is evaluated.
 * Set CANVAS_PROVIDER_TYPE=none to disable DataCanvas.
 *
 * `./.env` is loaded here the way the framework loads it on its first config
 * parse (never overriding a variable already set), so a value set there wins
 * over the default. Nothing is validated or reported here: `createApp()` parses
 * the framework config and reports an invalid variable, or a `.env` it cannot
 * read, with its startup banner.
 * @module config/canvas-default
 */

import { normalizeEnv } from '@cyanheads/mcp-ts-core/config';

try {
  process.loadEnvFile();
} catch {
  /**
   * No .env is the normal case. Any other failure is left to `createApp()`,
   * whose own load of the same file stops startup with the banner — a throw
   * here would print a raw stack before the banner can.
   */
}

if (normalizeEnv(process.env).CANVAS_PROVIDER_TYPE === undefined) {
  process.env.CANVAS_PROVIDER_TYPE = 'duckdb';
}
