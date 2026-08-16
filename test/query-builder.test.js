/**
 * Unit tests for the SQL builders — pure logic, no database needed.
 * These pin down the security contract: identifiers allowlisted + escaped,
 * values parameterized, limits clamped, and the update footgun (no where)
 * rejected.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { buildSelectQuery, buildInsertQuery, buildUpdateQuery } from '../db.js';

test('SELECT: valid query builds correct SQL and params', () => {
  const q = buildSelectQuery({
    table: 'users',
    columns: ['id', 'name'],
    where: { status: 'active' },
    order_by: 'id DESC',
    limit: 5,
  });
  assert.equal(q.sql, 'SELECT `id`, `name` FROM ?? WHERE ?? = ? ORDER BY ?? DESC LIMIT ? OFFSET ?');
  assert.deepEqual(q.params, ['users', 'status', 'active', 'id', 5, 0]);
  assert.equal(q.limit, 5);
});

test('SELECT: default columns is the bare * wildcard (regression: ?? escapes it into `*`)', () => {
  const q = buildSelectQuery({ table: 't' });
  assert.equal(q.sql, 'SELECT * FROM ?? LIMIT ? OFFSET ?');
  assert.deepEqual(q.params, ['t', 20, 0]);
});

test('SELECT: limit clamps to [1, 200] with default 20', () => {
  assert.equal(buildSelectQuery({ table: 't', limit: 99999 }).limit, 200);
  assert.equal(buildSelectQuery({ table: 't', limit: -5 }).limit, 1);
  assert.equal(buildSelectQuery({ table: 't' }).limit, 20);
});

test('SELECT: injection and malformed input are rejected', () => {
  const attacks = [
    { table: 'users; DROP TABLE users' },
    { table: 'users', columns: ['id; DROP'] },
    { table: 'users', columns: ['*', 'id'] },
    { table: 'users', columns: [] },
    { table: 'users', where: { "x' OR '1'='1": 1 } },
    { table: 'users', where: 'status' },
    { table: 'users', order_by: 'id DESC; DROP TABLE x' },
    { table: 'users', order_by: 'id SIDEWAYS' },
  ];
  for (const a of attacks) {
    assert.throws(() => buildSelectQuery(a), /Invalid|must |only/, JSON.stringify(a));
  }
});

test('INSERT: columns-then-values param order (regression: values were interleaved)', () => {
  const q = buildInsertQuery({ table: 'users', values: { name: 'Dave', status: 'active' } });
  assert.equal(q.sql, 'INSERT INTO ?? (??, ??) VALUES (?, ?)');
  assert.deepEqual(q.params, ['users', 'name', 'status', 'Dave', 'active']);
});

test('INSERT: injection and malformed input are rejected', () => {
  assert.throws(() => buildInsertQuery({ table: 'users; DROP', values: { a: 1 } }), /Invalid/);
  assert.throws(() => buildInsertQuery({ table: 'users', values: { "x'; DROP": 1 } }), /Invalid/);
  assert.throws(() => buildInsertQuery({ table: 'users' }), /values must be/);
  assert.throws(() => buildInsertQuery({ table: 'users', values: {} }), /values must be/);
});

test('UPDATE: valid build, default limit 1, hard cap 100', () => {
  const q = buildUpdateQuery({ table: 'users', set: { status: 'vip' }, where: { id: 42 } });
  assert.equal(q.sql, 'UPDATE ?? SET ?? = ? WHERE ?? = ? LIMIT ?');
  assert.deepEqual(q.params, ['users', 'status', 'vip', 'id', 42, 1]);
  assert.equal(buildUpdateQuery({ table: 't', set: { a: 1 }, where: { b: 2 }, limit: 999 }).limit, 100);
});

test('UPDATE: where-less update is rejected (the classic footgun)', () => {
  assert.throws(
    () => buildUpdateQuery({ table: 'users', set: { status: 'x' } }),
    /where is REQUIRED/,
  );
  assert.throws(
    () => buildUpdateQuery({ table: 'users', set: { status: 'x' }, where: {} }),
    /where is REQUIRED/,
  );
  assert.throws(() => buildUpdateQuery({ table: 'users', set: {}, where: { id: 1 } }), /set must be/);
});

test('UPDATE: injection is rejected', () => {
  assert.throws(
    () => buildUpdateQuery({ table: 'users', set: { "x' = 1; DROP": 1 }, where: { id: 1 } }),
    /Invalid/,
  );
  assert.throws(
    () => buildUpdateQuery({ table: 'users', set: { a: 1 }, where: { "id' OR '1'='1": 1 } }),
    /Invalid/,
  );
});
