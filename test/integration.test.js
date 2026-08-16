/**
 * Integration tests — drive the REAL server over the MCP protocol against a
 * REAL MySQL, exactly like Claude Code would.
 *
 * Requirements: a MySQL with a seeded mcp_test database. The local dev setup
 * (Docker container) provides it; override via env when pointing elsewhere:
 *   TEST_DB_HOST / TEST_DB_PORT / TEST_DB_USER / TEST_DB_PASSWORD / TEST_DB_NAME
 *   TEST_DB_RW_USER / TEST_DB_RW_PASSWORD   (write-suite; skipped if unset)
 *   TEST_DB_ADMIN_PASSWORD                  (cleanup of write-test rows)
 *
 * Without a reachable database the DB suites are SKIPPED — the unit suites
 * still run, so `npm test` works on any machine.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import mysql from 'mysql2/promise';
import { McpClient } from './helpers/mcp-client.js';

const DB = {
  host: process.env.TEST_DB_HOST || '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT || 3306),
  user: process.env.TEST_DB_USER || 'mcp_ro',
  password: process.env.TEST_DB_PASSWORD || 'mcp_ro_pass',
  name: process.env.TEST_DB_NAME || 'mcp_test',
  rwUser: process.env.TEST_DB_RW_USER || '',
  rwPassword: process.env.TEST_DB_RW_PASSWORD || '',
  adminPassword: process.env.TEST_DB_ADMIN_PASSWORD || '',
};

function serverEnv(extra = {}) {
  return {
    DB_HOST: DB.host,
    DB_PORT: String(DB.port),
    DB_USER: DB.user,
    DB_PASSWORD: DB.password,
    DB_NAME: DB.name,
    ...extra,
  };
}

// Preflight — module top-level so describe({ skip }) is decided up front.
let dbUp = false;
let tables = [];
try {
  const conn = await mysql.createConnection({
    host: DB.host, port: DB.port, user: DB.user, password: DB.password,
    database: DB.name, connectTimeout: 3000,
  });
  const [rows] = await conn.query('SHOW TABLES');
  tables = rows.map((r) => Object.values(r)[0]);
  await conn.end();
  dbUp = true;
} catch { /* skip DB suites below */ }

const skipReason = 'MySQL test DB unreachable — set TEST_DB_* env or start the Docker container';

describe('read tools (default server)', { skip: dbUp ? false : skipReason }, () => {
  let client;

  before(async () => {
    client = new McpClient(serverEnv());
    await client.init();
  });

  after(() => client.close());

  it('advertises exactly the 5 read tools (no write tools by default)', async () => {
    const names = (await client.listTools()).map((t) => t.name).sort();
    assert.deepEqual(names, [
      'check_permissions', 'describe_table', 'list_tables', 'ping', 'query_table',
    ]);
  });

  it('ping → ok', async () => {
    const r = await client.call('ping', {});
    assert.equal(r.isError, false);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.mysql, true);
  });

  it('list_tables → seeded tables', async () => {
    const r = await client.call('list_tables', {});
    assert.ok(r.data.tables.includes('users'));
    assert.ok(r.data.tables.includes('orders'));
  });

  it('describe_table → real columns', async () => {
    const r = await client.call('describe_table', { table: 'users' });
    const cols = r.data.columns.map((c) => c.COLUMN_NAME);
    assert.ok(cols.includes('name') && cols.includes('status'));
  });

  it('query_table filters and orders', async () => {
    const r = await client.call('query_table', {
      table: 'users',
      where: { status: 'active' },
      order_by: 'id DESC',
      columns: ['id', 'name'],
    });
    assert.equal(r.data.count, 2);
    assert.equal(r.data.rows[0].name, 'Carol'); // id DESC → highest id first
  });

  it('query_table default columns = * (wildcard regression)', async () => {
    const r = await client.call('query_table', { table: 'users', limit: 1 });
    const row = r.data.rows[0];
    assert.ok(row.id !== undefined && row.name !== undefined && row.status !== undefined);
  });

  it('missing table → hint points at list_tables', async () => {
    const r = await client.call('query_table', { table: 'nope' });
    assert.equal(r.isError, true);
    assert.match(r.text, /Hint: .*list_tables/);
  });

  it('missing column → hint points at describe_table with the real table name', async () => {
    const r = await client.call('query_table', { table: 'users', columns: ['nope_col'] });
    assert.equal(r.isError, true);
    assert.match(r.text, /in 'users'/);
    assert.match(r.text, /describe_table/);
  });

  it('check_permissions → read_only account', async () => {
    const r = await client.call('check_permissions', {});
    assert.equal(r.data.read_only, true);
  });

  it('large result is truncated with an actionable hint', { skip: tables.includes('logs') ? false : 'logs seed table missing' }, async () => {
    const r = await client.call('query_table', { table: 'logs' });
    assert.equal(r.data.truncated, true);
    assert.ok(r.data.fetched > r.data.count);
    assert.match(r.data.hint, /narrow it|WHERE|offset/i);
  });

  it('write tools are NOT advertised, and guessing their names is refused', async () => {
    const names = (await client.listTools()).map((t) => t.name);
    assert.ok(!names.includes('insert_row'));
    const r = await client.call('insert_row', { table: 'users', values: { name: 'Hack' } });
    assert.equal(r.isError, true);
    assert.match(r.text, /Write tools are disabled/);
  });

  it('audit log records shape only (tool + table, no values)', () => {
    assert.match(client.stderrText, /\[mysql-mcp\] query_table table=users/);
    assert.doesNotMatch(client.stderrText, /active/); // WHERE value must not appear
  });
});

describe('write tools (ALLOW_WRITES=1 + rw account)', {
  skip: dbUp && DB.rwUser ? false : 'TEST_DB_RW_USER/PASSWORD unset or DB down',
}, () => {
  const WRITE_NAME = 'McpTestUser';
  let client;

  before(async () => {
    client = new McpClient(serverEnv({ ALLOW_WRITES: '1', DB_USER: DB.rwUser, DB_PASSWORD: DB.rwPassword }));
    await client.init();
  });

  after(async () => {
    client.close();
    if (DB.adminPassword) {
      const conn = await mysql.createConnection({
        host: DB.host, port: DB.port, user: 'root', password: DB.adminPassword, database: DB.name,
      });
      await conn.query('DELETE FROM users WHERE name = ?', [WRITE_NAME]);
      await conn.end();
    }
  });

  it('advertises all 7 tools', async () => {
    const names = (await client.listTools()).map((t) => t.name);
    assert.ok(names.includes('insert_row') && names.includes('update_rows'));
  });

  it('insert_row → verified read-back of the inserted row', async () => {
    const r = await client.call('insert_row', {
      table: 'users',
      values: { name: WRITE_NAME, email: 'mcptest@test.local', status: 'active' },
    });
    assert.equal(r.isError, false);
    assert.ok(r.data.inserted_id > 0);
    assert.equal(r.data.read_back_by, 'id');
    assert.equal(r.data.row.name, WRITE_NAME);
    assert.equal(r.data.row.status, 'active');
  });

  it('update_rows → affected count + read-back of the NEW state', async () => {
    const r = await client.call('update_rows', {
      table: 'users',
      set: { status: 'vip' },
      where: { name: WRITE_NAME },
    });
    assert.equal(r.isError, false);
    assert.equal(r.data.affected_rows, 1);
    assert.equal(r.data.updated_rows[0].status, 'vip');
  });

  it('where-less update is rejected (footgun defense)', async () => {
    const r = await client.call('update_rows', { table: 'users', set: { status: 'x' } });
    assert.equal(r.isError, true);
    assert.match(r.text, /where is REQUIRED/);
  });
});

describe('dead database port', () => {
  it('connection failure is classified retryable with a check-the-env hint', async () => {
    const client = new McpClient(serverEnv({ DB_PORT: '3999' }));
    await client.init();
    const r = await client.call('ping', {});
    client.close();
    assert.equal(r.isError, false); // ping returns its error as DATA, not as an error result
    assert.equal(r.data.ok, false);
    assert.match(r.data.error, /ECONNREFUSED/);
  });

  it('a query against a dead port returns the retryable hint', async () => {
    const client = new McpClient(serverEnv({ DB_PORT: '3999' }));
    await client.init();
    const r = await client.call('list_tables', {});
    client.close();
    assert.equal(r.isError, true);
    assert.match(r.text, /Hint: Could not reach the database/);
    assert.match(r.text, /retrying the query is safe/);
  });
});
