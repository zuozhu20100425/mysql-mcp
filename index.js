#!/usr/bin/env node
/**
 * mysql-mcp — MCP Server
 *
 * Bridges Claude Code (stdio MCP) to a MySQL database (read-only by default).
 * Modeled on browser-mcp's mcp-server/index.js: same SDK surface, same
 * dispatch pattern, same lifecycle handling (parent-death detection,
 * graceful shutdown).
 *
 * Architecture:
 *   Claude Code ←(stdio)→ this process ←(mysql2 pool)→ MySQL
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { TOOLS, WRITE_TOOLS } from './tools.js';
import {
  ping, close, listTables, describeTable, queryTable, checkPermissions,
  insertRow, updateRows, writesEnabled, classifyDbError,
} from './db.js';

// Read version from package.json — single source of truth, never drifts
const PKG_VERSION = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')
).version;

// ── Behavior instructions for the LLM ────────────────────────────────────────

// Idle tracking — updated on every tool call, checked by the idle timer below
let lastActivity = Date.now();

const INSTRUCTIONS = `You can query a MySQL database through this MCP server. Read-only.

## Querying workflow (follow this order)
1. list_tables — see what tables exist. Never guess table names.
2. describe_table on the table you need — learn the real column names and types before querying.
3. query_table with a small limit and narrow columns first; expand only when you need more.

## Query rules
- query_table takes structured parameters only — there is no SQL passthrough. WHERE is equality-only ({ status: "active" }), values are parameterized server-side.
- Keep result sets small: limit defaults to 20 and is hard-capped at 200 rows. If you need more, page with offset or narrow with WHERE/columns.
- If a result comes back with truncated: true, do NOT just re-query with a bigger limit — narrow first: add WHERE filters, select fewer columns, or page with offset. The truncation hint says exactly how many rows were dropped.
- You have READ access only. Never attempt to alter data, schema, or permissions.
- check_permissions reports whether the connected account is read-only. If it returns warnings (write privileges found), tell the user to switch to a SELECT-only account — do not just proceed.

## Writing (only when insert_row / update_rows appear in your tool list)
- update_rows REQUIRES a where filter and defaults to limit 1 — say explicitly how many rows you intend to touch. Never issue a where-less update.
- After every write, read back with query_table and report the verified new state (the write tools already read back, but double-checking the surrounding rows is good practice).
- Writes also require the DB account to hold the privilege — if a write fails with an access-denied hint, check check_permissions and ask the user to grant INSERT/UPDATE to the MCP account.

## When things fail
- Connection error → report the error text to the user and check that the server env has DB_HOST / DB_PORT / DB_USER / DB_PASSWORD / DB_NAME set.
- Table not found → call list_tables and pick a real name.
- Column not found → call describe_table again and use real column names.
- Unknown tool → only the tools listed by this server exist; do not invent SQL passthrough tools.`;

const server = new Server(
  { name: 'mysql-mcp', version: PKG_VERSION },
  { capabilities: { tools: {} } },
  { instructions: INSTRUCTIONS },
);

// Writes are opt-in: write tools are only ADVERTISED when ALLOW_WRITES=1,
// so a default server looks read-only even to the model.
const activeTools = writesEnabled() ? [...TOOLS, ...WRITE_TOOLS] : TOOLS;

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: activeTools,
}));

// Tool name → implementation. Same dispatch pattern as browser-mcp's methodMap.
const handlers = {
  ping,
  list_tables: listTables,
  describe_table: describeTable,
  query_table: queryTable,
  check_permissions: checkPermissions,
  insert_row: insertRow,
  update_rows: updateRows,
};

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  lastActivity = Date.now();
  const { name, arguments: args } = request.params;

  try {
    const handler = handlers[name];
    if (!handler) {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true,
      };
    }
    // Defense in depth: even if the model guesses a write tool name that is
    // not advertised (ALLOW_WRITES unset), dispatch refuses it here.
    if ((name === 'insert_row' || name === 'update_rows') && !writesEnabled()) {
      return {
        content: [{
          type: 'text',
          text: 'Error: Write tools are disabled. Set ALLOW_WRITES=1 in the server env config to enable insert_row / update_rows.',
        }],
        isError: true,
      };
    }
    const result = await handler(args || {});
    // Audit log — shape only, never values (same secret-hygiene contract as
    // browser-mcp's action log: table names and row counts are fine, data is not).
    process.stderr.write(
      `[mysql-mcp] ${name}${args?.table ? ` table=${args.table}` : ''} rows=${result?.count ?? '-'}\n`,
    );
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    // Raw errors → LLM-actionable errors: original message + a hint that says
    // which tool to call next or what to check.
    const { error, hint, retryable } = classifyDbError(err, { table: args?.table });
    process.stderr.write(`[mysql-mcp] ${name} error: ${error}\n`);
    return {
      content: [{
        type: 'text',
        text: `Error: ${error}${hint ? `\nHint: ${hint}` : ''}${
          retryable ? '\n(transient connection error — retrying the query is safe)' : ''
        }`,
      }],
      isError: true,
    };
  }
});

// ── Graceful shutdown ────────────────────────────────────────────────────────
// Modeled on browser-mcp: detect parent death (Claude Code exit) because the
// MCP SDK's StdioServerTransport owns stdin, so stdin 'end' alone is not
// reliable. Without this, orphaned MCP processes pile up after each session.

let shuttingDown = false;
function gracefulShutdown(reason, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stderr.write(`[mysql-mcp] ${reason} — shutting down\n`);
  if (parentCheck) clearInterval(parentCheck);
  if (idleCheck) clearInterval(idleCheck);
  close().finally(() => process.exit(code));
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

const parentPid = process.ppid;
const parentCheck = setInterval(() => {
  try {
    process.kill(parentPid, 0); // signal 0 = check if process exists
  } catch {
    gracefulShutdown(`Parent process ${parentPid} died`);
  }
}, 5000);

// Idle timeout: 4 hours without commands → exit (same policy as browser-mcp)
const idleCheck = setInterval(() => {
  if (Date.now() - lastActivity > 4 * 60 * 60 * 1000) {
    gracefulShutdown('Idle timeout (4h)');
  }
}, 20000);

// Backup: stdin close
process.stdin.on('end', () => gracefulShutdown('stdin closed'));

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[mysql-mcp] MySQL MCP server running (stdio) v${PKG_VERSION}\n`);
