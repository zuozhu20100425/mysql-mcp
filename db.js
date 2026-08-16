/**
 * mysql-mcp — Database layer
 *
 * Lazy connection pool: the MCP server must start (and stay alive) even when
 * the database is down — same principle as browser-mcp starting without a
 * Chrome extension. The pool is created on first use, so a dead DB surfaces
 * as a tool-level error the LLM can act on, not a server crash.
 *
 * Security model (three tiers, all enforced here):
 *   1. No raw SQL reaches the DB — every query is built from structured params.
 *   2. Identifiers (table/column names) are allowlisted to a sane charset AND
 *      escaped via mysql2's ?? placeholder (regex alone, or escaping alone,
 *      would not be enough).
 *   3. Values go through ? placeholders only — string interpolation is banned.
 *      The DB account itself should still be GRANT SELECT-only (defense in depth).
 */

import mysql from 'mysql2/promise';

let pool = null;

function getPool() {
  if (pool) return pool;

  const user = process.env.DB_USER;
  if (!user) {
    throw new Error(
      'DB_USER is not set. Configure the mysql-mcp server env in your MCP config ' +
        '(DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME).'
    );
  }

  pool = mysql.createPool({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user,
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME,
    connectTimeout: 5000,
    // Safety: multi-statement is the classic injection amplifier (`a; DROP ...`).
    // mysql2 leaves it disabled by default — keep it that way forever.
    multipleStatements: false,
    waitForConnections: true,
    connectionLimit: 5,
  });

  return pool;
}

// Per-query timeout — a runaway query must not hang the tool call forever.
// mysql2 kills the connection on timeout and surfaces PROTOCOL_SEQUENCE_TIMEOUT.
const QUERY_TIMEOUT_MS = Number(process.env.DB_QUERY_TIMEOUT_MS || 10000);

// ── Error classification ─────────────────────────────────────────────────────
// Raw MySQL/network errors are translated into LLM-actionable messages:
// every error carries a hint telling the model what to DO next (which tool to
// call, what to check) — the same philosophy as browser-mcp's tool errors
// ("try text selector instead of CSS").

const RETRYABLE_CODES = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET',
  'PROTOCOL_CONNECTION_LOST', 'EPIPE',
]);

/**
 * Map an error to { error, hint, retryable }. Exported for unit tests.
 * `context` carries what the dispatcher already knows (e.g. the requested
 * table) because MySQL's own messages are lossy — a SELECT column error
 * reports 'field list', not the table name.
 */
export function classifyDbError(err, context = {}) {
  const code = err?.code || '';
  const message = err?.message || String(err);
  const retryable = RETRYABLE_CODES.has(code);

  if (code === 'ER_NO_SUCH_TABLE') {
    const m = /Table '(?:[^']*\.)?([^']+)' doesn't exist/.exec(message);
    return {
      error: message,
      hint: `Table '${m?.[1] ?? context.table ?? '?'}' does not exist. Call list_tables to see the real table names.`,
      retryable: false,
    };
  }
  if (code === 'ER_BAD_FIELD_ERROR') {
    const m = /Unknown column '([^']+)' in '([^']+)'/.exec(message);
    const rawTarget = m?.[2] ?? '';
    // 'field list' is MySQL's placeholder — swap in the real table when the
    // dispatcher knows it (context.table), generic wording otherwise.
    const target =
      rawTarget === 'field list' ? (context.table ?? 'the queried table') : rawTarget;
    return {
      error: message,
      hint: `Column '${m?.[1] ?? '?'}' does not exist in '${target}'. Call describe_table to see the real column names.`,
      retryable: false,
    };
  }
  if (code === 'ER_TABLEACCESS_DENIED_ERROR' || code === 'ER_DBACCESS_DENIED_ERROR') {
    return {
      error: message,
      hint: 'Access denied — the connected account lacks privileges here. Call check_permissions to inspect the account grants.',
      retryable: false,
    };
  }
  if (code === 'ER_ACCESS_DENIED_ERROR') {
    return {
      error: message,
      hint: 'Authentication failed — check DB_USER and DB_PASSWORD in the server env config.',
      retryable: false,
    };
  }
  if (code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    return {
      error: message,
      hint: 'The query timed out. Narrow it: add WHERE filters, select fewer columns, or use a smaller limit with offset paging.',
      retryable: false,
    };
  }
  if (retryable) {
    return {
      error: message,
      hint: 'Could not reach the database. Check DB_HOST / DB_PORT / DB_NAME and that MySQL is running, then retry.',
      retryable: true,
    };
  }
  return { error: message, hint: null, retryable: false };
}

const MAX_QUERY_ATTEMPTS = 2;
const RETRY_DELAY_MS = 200;

/**
 * Run a query with the default timeout. ALL database access funnels through
 * here — single choke point for timeout policy, retry policy and auditing.
 *
 * Retry policy: only transient CONNECTION failures retry (SELECTs are
 * idempotent, a dropped connection is safe to re-run). SQL errors — syntax,
 * missing table/column, denied privileges — are never retried: retrying them
 * wastes time and can double side effects if the surface ever gains writes.
 * Same read-only/retryable split as browser-mcp's cdpSend whitelist.
 */
export async function runQuery(sql, params = [], timeoutMs = QUERY_TIMEOUT_MS) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_QUERY_ATTEMPTS; attempt++) {
    try {
      const [rows] = await getPool().query({ sql, timeout: timeoutMs }, params);
      return rows;
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_QUERY_ATTEMPTS - 1 && classifyDbError(err).retryable) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Verify both the MCP link and the DB link in one call.
 * Returns (never throws) so the server stays alive and the LLM
 * can read the error and guide the user.
 */
export async function ping() {
  try {
    const rows = await runQuery('SELECT 1 AS ok');
    return { ok: true, mysql: rows[0]?.ok === 1 };
  } catch (err) {
    return { ok: false, mysql: false, error: err.message };
  }
}

/** Close the pool on shutdown — call from index.js graceful shutdown. */
export async function close() {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
}

// ── Query safety ─────────────────────────────────────────────────────────────

const IDENTIFIER_RE = /^[A-Za-z0-9_$]{1,64}$/;
const MAX_ROWS = 200; // hard cap — a runaway query must not flood the LLM context
const MAX_COLUMNS = 50;

function validateIdent(name, label) {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid ${label}: ${JSON.stringify(String(name))}. ` +
        'Only letters, digits, underscore and $ are allowed (max 64 chars).'
    );
  }
  return name;
}

/**
 * Pure SQL builder for query_table — exported for unit testing.
 * Never accepts SQL fragments: where is equality-only key/value pairs,
 * order_by is "column [ASC|DESC]". Returns { sql, params } ready for
 * pool.query(sql, params); identifiers ride ?? placeholders, values ride ?.
 */
export function buildSelectQuery(args = {}) {
  const table = validateIdent(args.table, 'table name');

  const columns = args.columns ?? ['*'];
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error('columns must be a non-empty array of column names (or ["*"])');
  }
  if (columns.length > MAX_COLUMNS) {
    throw new Error(`Too many columns (max ${MAX_COLUMNS})`);
  }
  // '*' is the SQL wildcard — it must be the only entry and must NOT be escaped
  // (mysql2's ?? would quote it into a column literally named `*`).
  let selectClause;
  if (columns.includes('*')) {
    if (columns.length !== 1) {
      throw new Error('"*" must be the only entry in columns — use it alone or list real columns');
    }
    selectClause = '*';
  } else {
    // Identifiers are validated to a charset that cannot contain backticks,
    // so manual backtick-quoting after validation is safe.
    selectClause = columns.map((c) => '`' + validateIdent(c, 'column name') + '`').join(', ');
  }

  // WHERE: { column: value } → `col` = ? AND ... (equality only, by design)
  const where = args.where ?? {};
  if (typeof where !== 'object' || Array.isArray(where)) {
    throw new Error('where must be an object of { column: value } equality filters');
  }
  const clauses = [];
  const params = [table];
  for (const [col, value] of Object.entries(where)) {
    validateIdent(col, 'where column');
    clauses.push('?? = ?');
    params.push(col, value);
  }

  // ORDER BY: "column" or "column DESC"
  let orderClause = '';
  if (args.order_by !== undefined && args.order_by !== '') {
    const parts = String(args.order_by).trim().split(/\s+/);
    if (parts.length > 2) {
      throw new Error('order_by must look like "column" or "column DESC"');
    }
    validateIdent(parts[0], 'order_by column');
    const dir = (parts[1] ?? 'ASC').toUpperCase();
    if (dir !== 'ASC' && dir !== 'DESC') {
      throw new Error(`Invalid order direction: ${parts[1]}. Use ASC or DESC.`);
    }
    orderClause = `ORDER BY ?? ${dir}`;
    params.push(parts[0]);
  }

  // LIMIT / OFFSET: defaults 20/0, clamped into [1, MAX_ROWS] and >= 0
  const limit = Math.min(Math.max(Number(args.limit ?? 20) | 0, 1), MAX_ROWS);
  const offset = Math.max(Number(args.offset ?? 0) | 0, 0);

  const sql =
    `SELECT ${selectClause} FROM ??` +
    (clauses.length ? ' WHERE ' + clauses.join(' AND ') : '') +
    (orderClause ? ' ' + orderClause : '') +
    ' LIMIT ? OFFSET ?';

  return { sql, params: [...params, limit, offset], limit, offset };
}

// ── Tool implementations ─────────────────────────────────────────────────────

export async function listTables() {
  const rows = await runQuery('SHOW TABLES');
  const tables = rows.map((r) => Object.values(r)[0]);
  return { database: process.env.DB_NAME ?? null, tables };
}

export async function describeTable(args = {}) {
  const table = validateIdent(args.table, 'table name');
  const rows = await runQuery(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [process.env.DB_NAME, table],
  );
  if (rows.length === 0) {
    return {
      table,
      columns: [],
      warning: `Table '${table}' has no columns in database '${process.env.DB_NAME}'. Try list_tables first.`,
    };
  }
  return { table, columns: rows };
}

// ── Result truncation ────────────────────────────────────────────────────────
// Row-count cap (200) guards the DB; this guards the LLM context window.
// A 200-row result of wide rows can still be hundreds of KB — JSON-size the
// rows as they stream and cut at MAX_RESULT_CHARS with an actionable hint.

const MAX_RESULT_CHARS = 50000;

/** Keep rows until the serialized size would exceed the cap. Exported for unit tests. */
export function truncateRows(rows) {
  let total = 0;
  const kept = [];
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (total + size > MAX_RESULT_CHARS) return { rows: kept, truncated: true };
    kept.push(row);
    total += size;
  }
  return { rows: kept, truncated: false };
}

export async function queryTable(args = {}) {
  const { sql, params, limit, offset } = buildSelectQuery(args);
  const allRows = await runQuery(sql, params);
  const { rows, truncated } = truncateRows(allRows);
  return {
    rows,
    count: rows.length,
    fetched: allRows.length,
    truncated,
    ...(truncated
      ? {
          hint:
            `Result truncated at ${MAX_RESULT_CHARS} chars (${rows.length} of ${allRows.length} rows returned) ` +
            'to protect the context window. Narrow it: add WHERE filters, select fewer columns, ' +
            'or page with a smaller limit and offset.',
        }
      : {}),
    limit,
    offset,
    sql,
  };
}

// ── Permission self-check ────────────────────────────────────────────────────
// Tier-1 defense: the DB account itself should be SELECT-only. This tool lets
// the user (and the LLM) verify that in one call instead of trusting docs.

// Privileges that let an account change data or escalate. GRANT OPTION and ALL
// PRIVILEGES are included explicitly; the GRANT keyword at the start of every
// grant statement is parsed out, not matched as a privilege.
const DANGEROUS_PRIVS = new Set([
  'INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER',
  'GRANT OPTION', 'SUPER', 'FILE',
]);

function analyzeGrants(grants) {
  const found = new Set();
  for (const g of grants) {
    const m = /^GRANT\s+(.+?)\s+ON\s+/i.exec(g);
    if (!m) continue;
    for (const raw of m[1].split(',')) {
      const p = raw.trim().toUpperCase();
      if (p === 'ALL' || p === 'ALL PRIVILEGES') found.add('ALL PRIVILEGES');
      else if (DANGEROUS_PRIVS.has(p)) found.add(p);
    }
  }
  return [...found];
}

export async function checkPermissions() {
  const rows = await runQuery('SHOW GRANTS FOR CURRENT_USER');
  const grants = rows.map((r) => Object.values(r)[0]);
  const dangerous = analyzeGrants(grants);
  return {
    account: `${process.env.DB_USER}@${process.env.DB_HOST || '127.0.0.1'}`,
    read_only: dangerous.length === 0,
    grants,
    ...(dangerous.length
      ? {
          warnings: dangerous.map((p) =>
            `${p} privilege found — this account can modify data. ` +
            `Switch to a SELECT-only account for the MCP server (see README "Database account").`,
          ),
        }
      : {}),
  };
}

// ── Write support (off by default) ───────────────────────────────────────────
// Writes are opt-in at TWO levels:
//   1. Server level — ALLOW_WRITES=1 must be set, or the write tools are not
//      even advertised in tools/list, and dispatch refuses them anyway.
//   2. Database level — the connected account must actually hold INSERT/UPDATE
//      grants (check_permissions shows it). A read-only account + ALLOW_WRITES=1
//      fails cleanly with the ER_TABLEACCESS_DENIED hint.
// Safety defaults: update_rows REQUIRES a where filter and defaults to
// LIMIT 1 (the classic footgun is a where-less UPDATE wiping every row).
// Every write reads the affected rows back — the browser-mcp read-back
// verification pattern — and returns them as proof of what changed.

const WRITES_ENABLED = process.env.ALLOW_WRITES === '1';
const DEFAULT_UPDATE_LIMIT = 1;
const MAX_UPDATE_ROWS = 100;

export function writesEnabled() {
  return WRITES_ENABLED;
}

function assertWritesEnabled() {
  if (!WRITES_ENABLED) {
    throw new Error(
      'Write tools are disabled. Set ALLOW_WRITES=1 in the server env config to enable insert_row / update_rows.',
    );
  }
}

/**
 * Execute a statement and return the FULL mysql2 result (affectedRows,
 * insertId, ...). Writes go through here, not runQuery: they are NOT
 * idempotent, so runQuery's connection-retry policy must never apply to them.
 */
export async function runStatement(sql, params = [], timeoutMs = QUERY_TIMEOUT_MS) {
  const [result] = await getPool().query({ sql, timeout: timeoutMs }, params);
  return result;
}

export function buildInsertQuery(args = {}) {
  const table = validateIdent(args.table, 'table name');
  const values = args.values ?? {};
  if (typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length === 0) {
    throw new Error('values must be a non-empty object of { column: value } pairs');
  }
  const cols = [];
  const vals = [];
  // Param order must match placeholder order: table, ALL column names
  // (the ??s in the column list), THEN all values (the ?s in VALUES).
  const params = [table];
  for (const [col] of Object.entries(values)) {
    validateIdent(col, 'insert column');
    cols.push('??');
    vals.push('?');
    params.push(col);
  }
  params.push(...Object.values(values));
  const sql = `INSERT INTO ?? (${cols.join(', ')}) VALUES (${vals.join(', ')})`;
  return { sql, params };
}

export function buildUpdateQuery(args = {}) {
  const table = validateIdent(args.table, 'table name');
  const set = args.set ?? {};
  if (typeof set !== 'object' || Array.isArray(set) || Object.keys(set).length === 0) {
    throw new Error('set must be a non-empty object of { column: value } pairs');
  }
  const where = args.where ?? {};
  if (typeof where !== 'object' || Array.isArray(where) || Object.keys(where).length === 0) {
    throw new Error(
      'where is REQUIRED for update_rows — updating every row by accident is the classic footgun. ' +
        'Provide at least one equality filter, e.g. { id: 42 }.',
    );
  }
  const limit = Math.min(
    Math.max(Number(args.limit ?? DEFAULT_UPDATE_LIMIT) | 0, 1),
    MAX_UPDATE_ROWS,
  );
  const params = [table];
  const setClauses = [];
  const whereClauses = [];
  for (const [col, value] of Object.entries(set)) {
    validateIdent(col, 'set column');
    setClauses.push('?? = ?');
    params.push(col, value);
  }
  for (const [col, value] of Object.entries(where)) {
    validateIdent(col, 'where column');
    whereClauses.push('?? = ?');
    params.push(col, value);
  }
  const sql = `UPDATE ?? SET ${setClauses.join(', ')} WHERE ${whereClauses.join(' AND ')} LIMIT ?`;
  params.push(limit);
  return { sql, params, limit };
}

export async function insertRow(args = {}) {
  assertWritesEnabled();
  const { sql, params } = buildInsertQuery(args);
  const result = await runStatement(sql, params);

  // Read-back verification: return the row as the DB now sees it. Prefer the
  // auto-increment id; fall back to selecting by the inserted values.
  let row = null;
  let readBackBy = null;
  if (result.insertId) {
    try {
      const after = await queryTable({ table: args.table, where: { id: result.insertId }, limit: 1 });
      row = after.rows[0] ?? null;
      readBackBy = 'id';
    } catch { /* fall through to values-based read-back */ }
  }
  if (row === null) {
    try {
      const after = await queryTable({ table: args.table, where: args.values, limit: 1 });
      row = after.rows[0] ?? null;
      readBackBy = 'values';
    } catch { /* read-back is best-effort */ }
  }

  return {
    inserted_id: result.insertId || null,
    affected_rows: result.affectedRows,
    row,
    ...(readBackBy ? { read_back_by: readBackBy } : {}),
    sql,
  };
}

export async function updateRows(args = {}) {
  assertWritesEnabled();
  const { sql, params, limit } = buildUpdateQuery(args);
  const result = await runStatement(sql, params);

  // Read-back verification: re-select with the same filters and return the
  // rows as they now exist — proof the write landed, plus the new state.
  const after = await queryTable({ table: args.table, where: args.where, limit });

  return {
    affected_rows: result.affectedRows,
    updated_rows: after.rows,
    read_back_count: after.count,
    sql,
  };
}
