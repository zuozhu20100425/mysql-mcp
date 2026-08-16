#!/usr/bin/env node

/**
 * mysql-mcp CLI
 *
 * Usage:
 *   node bin/cli.js install   — add the server to ~/.claude/mcp.json (LOCAL path — no npm publish needed)
 *   node bin/cli.js           — start MCP server (Claude Code calls this)
 *
 * Dev-mode install: points Claude Code at this checkout's index.js directly,
 * the same pattern as browser-mcp's install.sh dev mode. The published-package
 * form (npx ...@latest) is deliberately absent until the package exists on npm.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const command = process.argv[2];

if (command === 'install') {
  install();
} else if (!command) {
  // No subcommand = start MCP server (Claude Code calls this)
  await import('../index.js');
} else {
  console.log(`
mysql-mcp — query MySQL tables from Claude Code (read-only)

Usage:
  node bin/cli.js install   Configure Claude Code (writes ~/.claude/mcp.json)
  node bin/cli.js           Start MCP server (called by Claude Code)
`);
}

function install() {
  const claudeDir = join(homedir(), '.claude');
  const mcpJsonPath = join(claudeDir, 'mcp.json');
  let config = {};

  if (existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
    } catch {}
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Point at THIS checkout — absolute path derived from the CLI's own location,
  // so `node bin/cli.js install` works from any cwd.
  const serverPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'index.js');

  // ${VAR} placeholders — Claude Code resolves them from your environment,
  // so credentials never sit in this file (which you may commit or share).
  config.mcpServers['mysql-mcp'] = {
    command: 'node',
    args: [serverPath],
    env: {
      DB_HOST: '${DB_HOST}',
      DB_PORT: '${DB_PORT}',
      DB_USER: '${DB_USER}',
      DB_PASSWORD: '${DB_PASSWORD}',
      DB_NAME: '${DB_NAME}',
    },
  };

  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`✅ Claude Code configured (${mcpJsonPath})`);

  console.log(`
📋 Next steps:
  1. Create a READ-ONLY MySQL user (recommended, do not use your app account):
     CREATE USER 'mcp_ro'@'%' IDENTIFIED BY '<strong-password>';
     GRANT SELECT ON <your_db>.* TO 'mcp_ro'@'%';
  2. Export the connection vars in your shell profile (~/.zshrc):
     export DB_HOST=127.0.0.1
     export DB_PORT=3306
     export DB_USER=mcp_ro
     export DB_PASSWORD=<strong-password>
     export DB_NAME=<your_db>
  3. Restart Claude Code — the mysql-mcp tools are now available.
  4. Verify: ask Claude to call check_permissions — read_only should be true.
`);
}
