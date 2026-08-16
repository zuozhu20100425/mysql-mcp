/**
 * Minimal MCP stdio test client — spawns the real server and speaks JSON-RPC
 * over stdin/stdout, exactly like Claude Code would. No MCP SDK dependency on
 * the client side; the wire protocol (newline-delimited JSON-RPC 2.0) is all
 * the SDK adds on top.
 */

import { spawn } from 'child_process';

export class McpClient {
  constructor(env = {}) {
    this.p = spawn(process.execPath, ['index.js'], {
      cwd: new URL('../../', import.meta.url).pathname,
      env: { ...process.env, ...env },
    });
    this.buf = '';
    this.id = 0;
    this.pending = new Map();
    this.stderrText = '';
    this.p.stderr.on('data', (d) => { this.stderrText += d; });
    this.p.stdout.on('data', (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const { resolve } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          resolve(msg);
        }
      }
    });
  }

  send(obj) {
    this.p.stdin.write(JSON.stringify(obj) + '\n');
  }

  request(method, params) {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.pending.set(id, { resolve });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** initialize handshake — required before any other request. */
  async init() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    });
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }

  async listTools() {
    const res = await this.request('tools/list', {});
    return res.result.tools;
  }

  /**
   * Call a tool. Returns { isError, text, data } where data is the parsed
   * JSON of the text content (tools return JSON), null if unparseable.
   */
  async call(name, args = {}) {
    const res = await this.request('tools/call', { name, arguments: args });
    const result = res.result ?? {
      isError: true,
      content: [{ type: 'text', text: JSON.stringify(res.error) }],
    };
    const text = result.content?.[0]?.text ?? '';
    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    return { isError: result.isError === true, text, data };
  }

  close() {
    this.p.kill('SIGTERM');
  }
}
