/**
 * mysql-mcp — Tool Definitions
 *
 * Defines the MCP tools exposed to Claude Code. The query surface is
 * deliberately structured (no raw SQL strings) so the worst possible outcome
 * is a SELECT that returns too many rows — never a write, never a drop.
 */

export const TOOLS = [
  {
    name: 'ping',
    description:
      'Check MCP server and MySQL connectivity. Returns whether the database connection works. ' +
      'Call this first whenever you are unsure whether the database is reachable — the error ' +
      'field tells you what to fix (missing env vars, wrong credentials, host unreachable).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_tables',
    description:
      'List all tables in the connected database. Always start here when you do not know ' +
      'what tables exist — do not guess table names.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'describe_table',
    description:
      'Describe a table: column names, types, nullability, keys, defaults, and column comments. ' +
      'Always call this BEFORE query_table so you query with real column names. Returns a warning ' +
      '(not an error) if the table does not exist.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (from list_tables)' },
      },
      required: ['table'],
    },
  },
  {
    name: 'query_table',
    description:
      'Query rows from a table with structured parameters — no SQL strings are accepted. ' +
      'WHERE conditions are equality-only key/value pairs ({ status: "active" }); use columns to ' +
      'narrow the output; limit defaults to 20 and is hard-capped at 200 rows. ' +
      'Workflow: describe_table first to learn column names, then query with a small limit and ' +
      'narrow columns, expanding only when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (from list_tables)' },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: 'Columns to return, e.g. ["id", "name"]. Default: all columns ("*"). Max 50.',
        },
        where: {
          type: 'object',
          description:
            'Equality filters as { column: value } pairs, combined with AND. ' +
            'e.g. { "status": "active", "user_id": 42 }. No operators or SQL fragments — ' +
            'values are parameterized and never interpolated.',
        },
        order_by: {
          type: 'string',
          description: 'Ordering as "column" or "column DESC", e.g. "id DESC". Default: no ordering.',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return. Default 20, hard cap 200.',
        },
        offset: {
          type: 'number',
          description: 'Rows to skip. Default 0. Prefer WHERE filters over offset for large tables.',
        },
      },
      required: ['table'],
    },
  },
  {
    name: 'check_permissions',
    description:
      'Show the connected MySQL account\'s privileges and whether it is read-only. ' +
      'Call this when the user asks about database security, or to verify that writes are ' +
      'impossible before running queries. If read_only is false, the account CAN modify data — ' +
      'recommend switching to a SELECT-only account.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Write tools — only advertised and dispatched when the server runs with
// ALLOW_WRITES=1 (see index.js). Kept in a separate export so the read-only
// surface stays the default.
export const WRITE_TOOLS = [
  {
    name: 'insert_row',
    description:
      'Insert a single row. values is a { column: value } object — all values are parameterized, ' +
      'no SQL fragments. After the insert, the server reads the row back and returns it as ' +
      'verification (the response contains the row as the database now stores it). ' +
      'Prefer update_rows over delete-then-insert; this tool cannot modify existing rows.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (from list_tables)' },
        values: {
          type: 'object',
          description: '{ column: value } pairs for the new row, e.g. { "name": "Dave", "status": "active" }',
        },
      },
      required: ['table', 'values'],
    },
  },
  {
    name: 'update_rows',
    description:
      'Update rows that match equality filters. where is REQUIRED — a where-less UPDATE is the ' +
      'classic footgun (it hits every row) and is rejected. limit defaults to 1 (change exactly ' +
      'one row unless you say otherwise) and is capped at 100. set is a { column: value } object, ' +
      'all values parameterized. After the update the server reads the rows back with the same ' +
      'filters and returns their NEW state as verification.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name (from list_tables)' },
        set: {
          type: 'object',
          description: '{ column: value } pairs to write, e.g. { "status": "vip" }',
        },
        where: {
          type: 'object',
          description: 'REQUIRED equality filters, e.g. { "id": 42 }. Combined with AND.',
        },
        limit: {
          type: 'number',
          description: 'Max rows to update. Default 1 (safety), hard cap 100.',
        },
      },
      required: ['table', 'set', 'where'],
    },
  },
];
