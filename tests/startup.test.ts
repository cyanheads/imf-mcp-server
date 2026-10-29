/**
 * @fileoverview Startup of the built entry point under Node, from a working
 * directory holding only a `.env`: the DataCanvas default and the dataframe
 * tool gates honor `.env` values, and an invalid value stops startup with the
 * framework's configuration banner rather than a raw stack.
 * @module tests/startup.test
 */

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const entry = join(projectRoot, 'dist/index.js');
const workDirs: string[] = [];

beforeAll(() => {
  execFileSync('bun', ['run', 'build'], { cwd: projectRoot, stdio: 'ignore' });
}, 120_000);

afterAll(() => {
  for (const dir of workDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh working directory whose `.env` holds `dotenv`, or no `.env` at all. */
function workDir(dotenv?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'imf-startup-'));
  workDirs.push(dir);
  if (dotenv !== undefined) writeFileSync(join(dir, '.env'), `${dotenv}\n`);
  return dir;
}

type Startup =
  | { kind: 'listening'; tools: string[] }
  | { kind: 'exited'; code: number | null; stderr: string };

/**
 * Starts `node dist/index.js` over stdio in `cwd` with only `PATH` inherited,
 * and returns the `tools/list` names once it answers, or its exit code and
 * stderr when it stops first.
 */
function start(cwd: string): Promise<Startup> {
  const child: ChildProcess = spawn(process.execPath, [entry], {
    cwd,
    env: { PATH: process.env.PATH, MCP_TRANSPORT_TYPE: 'stdio' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const send = (message: object) => child.stdin?.write(`${JSON.stringify(message)}\n`);

  return new Promise<Startup>((resolve, reject) => {
    child.on('error', reject);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on('exit', (code) => resolve({ kind: 'exited', code, stderr }));
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk;
      for (let nl = stdout.indexOf('\n'); nl !== -1; nl = stdout.indexOf('\n')) {
        const message = JSON.parse(stdout.slice(0, nl)) as {
          id?: number;
          result?: { tools?: Array<{ name: string }> };
        };
        stdout = stdout.slice(nl + 1);
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        } else if (message.id === 2) {
          resolve({
            kind: 'listening',
            tools: (message.result?.tools ?? []).map((tool) => tool.name),
          });
          child.kill();
        }
      }
    });
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'startup-test', version: '0' },
      },
    });
  });
}

const BASE_TOOLS = ['imf_list_databases', 'imf_get_database', 'imf_query_dataset'];

describe('startup under Node', { timeout: 30_000 }, () => {
  it('defaults DataCanvas on: the describe and query dataframe tools are listed', async () => {
    expect(await start(workDir())).toEqual({
      kind: 'listening',
      tools: [...BASE_TOOLS, 'imf_dataframe_describe', 'imf_dataframe_query'],
    });
  });

  it('reads CANVAS_PROVIDER_TYPE=none from .env and lists no dataframe tool', async () => {
    expect(await start(workDir('CANVAS_PROVIDER_TYPE=none'))).toEqual({
      kind: 'listening',
      tools: BASE_TOOLS,
    });
  });

  it('reads IMF_ENABLE_DATAFRAME_DROP=true from .env and lists imf_dataframe_drop', async () => {
    expect(await start(workDir('IMF_ENABLE_DATAFRAME_DROP=true'))).toEqual({
      kind: 'listening',
      tools: [...BASE_TOOLS, 'imf_dataframe_describe', 'imf_dataframe_query', 'imf_dataframe_drop'],
    });
  });

  it.each([
    ['a server variable', 'IMF_REQUEST_TIMEOUT_MS=abc', 'IMF_REQUEST_TIMEOUT_MS'],
    ['a server timer out of range', 'IMF_REQUEST_TIMEOUT_MS=-5', 'IMF_REQUEST_TIMEOUT_MS'],
    ['a server flag', 'IMF_ENABLE_DATAFRAME_DROP=maybe', 'IMF_ENABLE_DATAFRAME_DROP'],
    ['a framework variable', 'CANVAS_DEFAULT_ROW_LIMIT=1.5', 'CANVAS_DEFAULT_ROW_LIMIT'],
    ['the canvas provider', 'CANVAS_PROVIDER_TYPE=sqlite', 'CANVAS_PROVIDER_TYPE'],
  ])('stops startup on an invalid %s with the banner naming it', async (_label, dotenv, name) => {
    const startup = await start(workDir(dotenv));

    expect(startup.kind).toBe('exited');
    if (startup.kind !== 'exited') return;
    expect(startup.code).toBe(1);
    expect(startup.stderr).toContain('Configuration error — server failed to start');
    expect(startup.stderr).toContain(`- ${name} (`);
    expect(startup.stderr).not.toMatch(/^\s+at /m);
  });
});
