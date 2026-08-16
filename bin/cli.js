#!/usr/bin/env node

/**
 * mysql-mcp CLI
 *
 * Usage:
 *   npx mysql-mcp install   — add the server to ~/.claude/mcp.json
 *   npx mysql-mcp           — start MCP server (Claude Code calls this)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
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
  npx mysql-mcp install   Configure Claude Code (writes ~/.claude/mcp.json)
  npx mysql-mcp           Start MCP server (called by Claude Code)
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

  // ${VAR} placeholders — Claude Code resolves them from your environment,
  // so credentials never sit in this file (which you may commit or share).
  config.mcpServers['mysql-mcp'] = {
    command: 'npx',
    args: ['-y', 'mysql-mcp@latest'],
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
