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

export function startTelemetryHttpServer(port = 3002): http.Server {
  const sessions = new Map<string, ActiveSession>();

  const httpServer = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200).end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // SSE connection endpoint
    if (req.method === 'GET' && (parsedUrl.pathname === '/sse' || parsedUrl.pathname === '/')) {
      // Create separate McpServer instance per SSE connection to satisfy SDK protocol isolation
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
      const sessionId = parsedUrl.searchParams.get('sessionId');
      const session = sessionId ? sessions.get(sessionId) : Array.from(sessions.values())[0];

      if (session) {
        await session.transport.handlePostMessage(req, res);
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found or expired' }));
      }
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

  httpServer.listen(port, () => {
    console.log(`🚀 Telemetry MCP Server (HTTP/SSE) listening on http://localhost:${port}/sse`);
  });

  return httpServer;
}

if (process.argv[1] === __filename) {
  const port = Number(process.env.TELEMETRY_MCP_PORT) || 3002;
  startTelemetryHttpServer(port);
}
