#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Client as SSHClient } from 'ssh2';
import { z } from 'zod';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';

// Example usage: node build/index.js --host=1.2.3.4 --port=22 --user=root --password=pass --key=path/to/key --timeout=5000
function parseArgv() {
  const args = process.argv.slice(2);
  const config: Record<string, string> = {};
  for (const arg of args) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) {
      config[match[1]] = match[2];
    }
  }
  return config;
}
const argvConfig = parseArgv();

const HOST = argvConfig.host;
const PORT = argvConfig.port ? parseInt(argvConfig.port) : 22;
const USER = argvConfig.user;
const PASSWORD = argvConfig.password;
const KEY = argvConfig.key;
const DEFAULT_TIMEOUT = argvConfig.timeout ? parseInt(argvConfig.timeout) : 60000; // 60 seconds default timeout
const LISTEN_HOST = argvConfig["listen-host"] ?? '0.0.0.0';
const LISTEN_PORT = argvConfig["listen-port"] ? parseInt(argvConfig["listen-port"]) : 3000;
const RAW_BASE_PATH = argvConfig["base-path"] ?? '/mcp';
const ENABLE_JSON_RESPONSE = parseBoolean(argvConfig["enable-json-response"]);
const ALLOW_ORIGIN = argvConfig["allow-origin"] ?? '*';

function parseBoolean(value?: string): boolean {
  if (value === undefined) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function normalizeBasePath(path: string): string {
  if (!path.startsWith('/')) {
    path = '/' + path;
  }
  if (path.length > 1 && path.endsWith('/')) {
    path = path.replace(/\/+$/, '');
  }
  return path;
}

const BASE_PATH = normalizeBasePath(RAW_BASE_PATH);

function validateConfig(config: Record<string, string>) {
  const errors = [];
  if (!config.host) errors.push('Missing required --host');
  if (!config.user) errors.push('Missing required --user');
  if (config.port && isNaN(Number(config.port))) errors.push('Invalid --port');
  if (config["listen-port"] && isNaN(Number(config["listen-port"]))) errors.push('Invalid --listen-port');
  if (BASE_PATH.length === 0) errors.push('Invalid --base-path');
  if (errors.length > 0) {
    throw new Error('Configuration error:\n' + errors.join('\n'));
  }
}

validateConfig(argvConfig);


const server = new McpServer({
  name: 'SSH MCP Server',
  version: '1.1.0',
  capabilities: {
    resources: {},
    tools: {},
  },
});

server.tool(
  "exec",
  "Execute a shell command on the remote SSH server and return the output.",
  {
    command: z.string().describe("Shell command to execute on the remote SSH server"),
  },
  async ({ command }) => {
    // Sanitize command input
    if (typeof command !== 'string' || !command.trim()) {
      throw new McpError(ErrorCode.InternalError, 'Command must be a non-empty string.');
    }

    const sshConfig: any = {
      host: HOST,
      port: PORT,
      username: USER,
    };
    try {
      if (PASSWORD) {
        sshConfig.password = PASSWORD;
      } else if (KEY) {
        const fs = await import('fs/promises');
        sshConfig.privateKey = await fs.readFile(KEY, 'utf8');
      }
      const result = await execSshCommand(sshConfig, command);
      return result;
    } catch (err: any) {
      // Wrap unexpected errors
      if (err instanceof McpError) throw err;
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err?.message || err}`);
    }
  }
);

async function execSshCommand(sshConfig: any, command: string): Promise<{ [x: string]: unknown; content: ({ [x: string]: unknown; type: "text"; text: string; } | { [x: string]: unknown; type: "image"; data: string; mimeType: string; } | { [x: string]: unknown; type: "audio"; data: string; mimeType: string; } | { [x: string]: unknown; type: "resource"; resource: any; })[] }> {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    let timeoutId: NodeJS.Timeout;
    let isResolved = false;
    
    // Set up timeout
    timeoutId = setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        // Try to abort the running command before closing connection
        const abortTimeout = setTimeout(() => {
          // If abort command itself times out, force close connection
          conn.end();
        }, 5000); // 5 second timeout for abort command
        
        conn.exec('timeout 3s pkill -f "' + command + '" 2>/dev/null || true', (err, abortStream) => {
          if (abortStream) {
            abortStream.on('close', () => {
              clearTimeout(abortTimeout);
              conn.end();
            });
          } else {
            clearTimeout(abortTimeout);
            conn.end();
          }
        });
        reject(new McpError(ErrorCode.InternalError, `Command execution timed out after ${DEFAULT_TIMEOUT}ms`));
      }
    }, DEFAULT_TIMEOUT);
    
    conn.on('ready', () => {
      conn.exec(command, (err, stream) => {
        if (err) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            reject(new McpError(ErrorCode.InternalError, `SSH exec error: ${err.message}`));
          }
          conn.end();
          return;
        }
        let stdout = '';
        let stderr = '';
        stream.on('close', (code: number, signal: string) => {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeoutId);
            conn.end();
            if (stderr) {
              reject(new McpError(ErrorCode.InternalError, `Error (code ${code}):\n${stderr}`));
            } else {
              resolve({
                content: [{
                  type: 'text',
                  text: stdout,
                }],
              });
            }
          }
        });
        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
      });
    });
    conn.on('error', (err) => {
      if (!isResolved) {
        isResolved = true;
        clearTimeout(timeoutId);
        reject(new McpError(ErrorCode.InternalError, `SSH connection error: ${err.message}`));
      }
    });
    conn.connect(sshConfig);
  });
}

async function main() {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: ENABLE_JSON_RESPONSE,
  });

  await server.connect(transport);

  const httpServer = createServer(async (req, res) => {
    try {
      await handleHttpRequest(transport, req, res);
    } catch (error) {
      console.error('Fatal error while handling request:', error);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(LISTEN_PORT, LISTEN_HOST, () => {
      console.error(
        `SSH MCP Server listening on http://${LISTEN_HOST}:${LISTEN_PORT}${BASE_PATH}`
      );
      resolve();
    });
  });
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

async function handleHttpRequest(
  transport: StreamableHTTPServerTransport,
  req: IncomingMessage,
  res: ServerResponse
) {
  if (!req.url) {
    writeCorsHeaders(res);
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing request URL' }));
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (!url.pathname.startsWith(BASE_PATH)) {
    if (req.method === 'OPTIONS') {
      writeCorsHeaders(res);
      res.writeHead(204).end();
      return;
    }

    writeCorsHeaders(res);
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
    return;
  }

  if (req.method === 'OPTIONS') {
    writeCorsHeaders(res);
    res.writeHead(204).end();
    return;
  }

  writeCorsHeaders(res);

  await transport.handleRequest(req, res);
}

function writeCorsHeaders(res: ServerResponse) {
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}