/**
 * @fileoverview Module-level accessor for the DataCanvas instance.
 * Wired in setup() from the createApp() entry point.
 * @module services/canvas/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Store the DataCanvas instance from CoreServices. Call once in setup(). */
export const setCanvas = (c: DataCanvas | undefined): void => {
  _canvas = c;
};

/** Returns the DataCanvas instance, or undefined when canvas is disabled. */
export const getCanvas = (): DataCanvas | undefined => _canvas;
