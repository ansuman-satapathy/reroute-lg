import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createTelemetryMcpServer } from './index.js';

const __filename = fileURLToPath(import.meta.url);

interface ActiveSession {
  server: McpServer;
  transport: SSEServerTransport;
}

export function startTelemetryHttpServer(
  port = 3002,
  host = process.env.TELEMETRY_MCP_HOST || '127.0.0.1'
): http.Server {
  const sessions = new Map<string, ActiveSession>();

  const httpServer = http.createServer(async (req, res) => {
    // Security: Restrict allowed origins
    const origin = req.headers.origin;
    const allowedOrigin =
      process.env.ALLOWED_ORIGIN ||
      (origin && (origin.includes('localhost') || origin.includes('127.0.0.1')) ? origin : '');

    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host || `${host}:${port}`}`);

    // SSE connection endpoint
    if (req.method === 'GET' && (parsedUrl.pathname === '/sse' || parsedUrl.pathname === '/')) {
      const server = createTelemetryMcpServer();
      const transport = new SSEServerTransport('/message', res);
      const sessionId = transport.sessionId;

      sessions.set(sessionId, { server, transport });

      transport.onclose = () => {
        sessions.delete(sessionId);
        console.log(`[Telemetry-MCP] SSE session closed: ${sessionId}`);
      };

      await server.connect(transport);
      console.log(`[Telemetry-MCP] SSE session connected: ${sessionId} (Active: ${sessions.size})`);
      return;
    }

    // Message POST endpoint for SSE sessions
    if (req.method === 'POST' && parsedUrl.pathname.startsWith('/message')) {
      // Fix for Qodo #4: Strictly require sessionId; never fall back to an arbitrary active session
      const sessionId = parsedUrl.searchParams.get('sessionId');
      if (!sessionId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required sessionId parameter' }));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Session '${sessionId}' not found or expired` }));
        return;
      }

      await session.transport.handlePostMessage(req, res);
      return;
    }

    // Health check endpoint
    if (req.method === 'GET' && parsedUrl.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          server: 'telemetry-mcp',
          transport: 'sse',
          sse_endpoint: '/sse',
          active_sessions: sessions.size,
        })
      );
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Endpoint not found' }));
  });

  httpServer.listen(port, host, () => {
    console.log(`🚀 Telemetry MCP Server (HTTP/SSE) listening on http://${host}:${port}/sse`);
  });

  return httpServer;
}

if (process.argv[1] === __filename) {
  const port = Number(process.env.TELEMETRY_MCP_PORT) || 3002;
  const host = process.env.TELEMETRY_MCP_HOST || '127.0.0.1';
  startTelemetryHttpServer(port, host);
}
