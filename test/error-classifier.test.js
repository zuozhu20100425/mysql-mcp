/**
 * Unit tests for error classification and result truncation — pure logic.
 * Pins down the LLM-facing error contract: every classified error carries a
 * hint saying what to DO next, and connection errors are marked retryable.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { classifyDbError, truncateRows } from '../db.js';

test('classifyDbError: table-missing → list_tables hint', () => {
  const r = classifyDbError({
    code: 'ER_NO_SUCH_TABLE',
    message: "Table 'mcp_test.nope' doesn't exist",
  });
  assert.match(r.hint, /Table 'nope' does not exist/);
  assert.match(r.hint, /list_tables/);
  assert.equal(r.retryable, false);
});

test('classifyDbError: column-missing → describe_table hint, context table wins over field list', () => {
  const r = classifyDbError(
    { code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'nope_col' in 'field list'" },
    { table: 'users' },
  );
  assert.match(r.hint, /Column 'nope_col' does not exist in 'users'/);
  assert.match(r.hint, /describe_table/);
});

test('classifyDbError: column-missing without context degrades gracefully', () => {
  const r = classifyDbError({ code: 'ER_BAD_FIELD_ERROR', message: "Unknown column 'x' in 'field list'" });
  assert.match(r.hint, /in 'the queried table'/);
});

test('classifyDbError: privilege denied → check_permissions hint', () => {
  const r = classifyDbError({ code: 'ER_TABLEACCESS_DENIED_ERROR', message: 'INSERT command denied' });
  assert.match(r.hint, /check_permissions/);
});

test('classifyDbError: bad credentials → env check hint', () => {
  const r = classifyDbError({ code: 'ER_ACCESS_DENIED_ERROR', message: 'Access denied for user' });
  assert.match(r.hint, /DB_USER and DB_PASSWORD/);
});

test('classifyDbError: query timeout → narrow-the-query hint', () => {
  const r = classifyDbError({ code: 'PROTOCOL_SEQUENCE_TIMEOUT', message: 'Query inactivity timeout' });
  assert.match(r.hint, /timed out.*WHERE/);
});

test('classifyDbError: connection errors are retryable, SQL errors are not', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST']) {
    const r = classifyDbError({ code, message: 'x' });
    assert.equal(r.retryable, true, code);
    assert.match(r.hint, /Could not reach the database/);
  }
  assert.equal(classifyDbError({ code: 'ER_PARSE_ERROR', message: 'syntax error' }).retryable, false);
});

test('classifyDbError: unknown errors carry no hint', () => {
  const r = classifyDbError({ code: 'ER_SOMETHING_ELSE', message: 'boom' });
  assert.equal(r.hint, null);
  assert.equal(r.retryable, false);
});

test('truncateRows: big result is truncated, small result is not', () => {
  const big = Array.from({ length: 100 }, (_, i) => ({ id: i, payload: 'x'.repeat(6000) }));
  const t = truncateRows(big);
  assert.equal(t.truncated, true);
  assert.ok(t.rows.length >= 7 && t.rows.length < 100, `truncated at ${t.rows.length} rows`);

  const small = truncateRows([{ a: 1 }, { b: 2 }]);
  assert.equal(small.truncated, false);
  assert.equal(small.rows.length, 2);
});
