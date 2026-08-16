# mysql-mcp

**Query MySQL tables from Claude Code — read-only by default.**

An MCP server that gives Claude Code (and any MCP client) read access to a MySQL
database through structured, parameterized query tools. No raw SQL passthrough
by default — the tool surface is designed so the worst possible outcome is a
SELECT that returns too many rows.

Modeled on [Agent360's browser-mcp](https://github.com/Agent360dk/browser-mcp)
(same MCP server patterns: stdio transport, lifecycle handling, LLM-facing tool
descriptions).

## Testing

```bash
npm test
```

Three layers, all under `node --test` (no test framework dependency):

| File | Layer | Needs DB? |
| ---- | ----- | --------- |
| [test/query-builder.test.js](test/query-builder.test.js) | SQL builder security contract (identifiers, params, clamps, footgun defense) | No |
| [test/error-classifier.test.js](test/error-classifier.test.js) | Error → LLM-hint mapping + result truncation | No |
| [test/integration.test.js](test/integration.test.js) | Full MCP protocol against a real MySQL, via [test/helpers/mcp-client.js](test/helpers/mcp-client.js) | Yes — suites skip gracefully when unreachable |

Integration env (defaults match the local Docker dev setup; override freely):

```
TEST_DB_HOST / TEST_DB_PORT / TEST_DB_USER / TEST_DB_PASSWORD / TEST_DB_NAME
TEST_DB_RW_USER / TEST_DB_RW_PASSWORD   → write suite (skipped if unset)
TEST_DB_ADMIN_PASSWORD                  → cleanup of write-test rows
```

## Status — M5

Five read tools plus two opt-in write tools, all integration-tested against a
real MySQL:

| Tool | What it does |
| ---- | ------------ |
| `ping` | Verify MCP + MySQL connectivity, returns guiding errors |
| `list_tables` | `SHOW TABLES` |
| `describe_table` | Column names/types/keys/defaults/comments via information_schema |
| `query_table` | Structured queries — key/value WHERE, column lists, order, limit (hard cap 200) |
| `check_permissions` | Shows the account's grants and whether it is read-only |
| `insert_row` *(opt-in)* | INSERT + read-back of the inserted row |
| `update_rows` *(opt-in)* | UPDATE with REQUIRED where, default LIMIT 1 (cap 100) + read-back of the new state |

## Writing — opt-in at two levels

Write tools exist only when **both** hold:

1. **Server**: started with `ALLOW_WRITES=1` — otherwise the tools are not
   even advertised in `tools/list`, and dispatch refuses them anyway.
2. **Database**: the connected account holds INSERT/UPDATE grants
   (verify with `check_permissions`).

Safety defaults on `update_rows`: `where` is required (a where-less UPDATE is
rejected — the classic footgun), `limit` defaults to **1** and caps at 100.
Every write reads the affected rows back and returns the verified new state.

## Security — three tiers, all enforced

| Tier | Defense | Where |
| ---- | ------- | ----- |
| 1. Database | SELECT-only account (`GRANT SELECT`, ideally on a replica) | Your DBA work — verified by `check_permissions` |
| 2. Connection | `multipleStatements: false`, `connectTimeout: 5s`, **per-query timeout 10s** (`DB_QUERY_TIMEOUT_MS` to tune) | [db.js](db.js) |
| 3. Application | No raw SQL passthrough; identifier allowlist + `??` escaping; values via `?` only; LIMIT hard cap 200 | [db.js](db.js) `buildSelectQuery` |

Every tool call is audited to stderr — shape only (tool, table name, row
count), never values. Same secret-hygiene contract as browser-mcp's action log.

## Reliability & LLM experience

- **Errors are LLM-actionable.** Raw MySQL/network errors are classified and
  shipped with a hint that says what to do next:
  `Error: Table 'x' doesn't exist` → `Hint: Call list_tables...`,
  `Unknown column` → `Hint: Call describe_table...`,
  connection failures → `Hint: Check DB_HOST / DB_PORT...` (marked retryable).
- **Retry policy.** Transient connection failures retry once automatically
  (SELECTs are idempotent); SQL errors never retry. Same read-only/retryable
  split as browser-mcp's CDP whitelist.
- **Result truncation.** Results are capped at 50,000 serialized chars
  (on top of the 200-row cap). When truncated, the response carries
  `truncated: true`, `fetched`, and a hint telling the model to narrow
  (WHERE filters, fewer columns, offset paging) instead of re-querying bigger.

## Roadmap

- ✅ M1–M6 core done: skeleton, query tools, security, reliability, opt-in writes, test suite
- ⏸️ npm publishing — skipped by decision; add `@scope` name, LICENSE, registry metadata (`server.json` / `glama.json`) if you ever publish

## Install

```bash
npx mysql-mcp install
```

This writes the `mysql-mcp` server into `~/.claude/mcp.json` with `${VAR}`
placeholders — credentials are resolved from your environment, never stored in
the config file:

```json
{
  "mcpServers": {
    "mysql-mcp": {
      "command": "npx",
      "args": ["-y", "mysql-mcp@latest"],
      "env": {
        "DB_HOST": "${DB_HOST}",
        "DB_PORT": "${DB_PORT}",
        "DB_USER": "${DB_USER}",
        "DB_PASSWORD": "${DB_PASSWORD}",
        "DB_NAME": "${DB_NAME}"
      }
    }
  }
}
```

## Database account — read-only, always

```sql
CREATE USER 'mcp_ro'@'%' IDENTIFIED BY '<strong-password>';
GRANT SELECT ON <your_db>.* TO 'mcp_ro'@'%';
```

Point it at a read replica if you have one.

## Dev

```bash
npm ci
node index.js    # → [mysql-mcp] MySQL MCP server running (stdio)
```

## Environment variables

| Var          | Default     | Description            |
| ------------ | ----------- | ---------------------- |
| `DB_HOST`    | `127.0.0.1` | MySQL host             |
| `DB_PORT`    | `3306`      | MySQL port             |
| `DB_USER`    | *(required)*| MySQL user             |
| `DB_PASSWORD`| *(empty)*   | MySQL password         |
| `DB_NAME`    | *(none)*    | Default database       |
| `DB_QUERY_TIMEOUT_MS` | `10000` | Per-query timeout in ms |
| `ALLOW_WRITES` | *(unset)* | Set to `1` to enable `insert_row` / `update_rows` |

## License

MIT
