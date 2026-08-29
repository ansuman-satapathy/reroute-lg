import { startErpHttpServer } from '../mcp-servers/erp/src/http.js';
import { startTelemetryHttpServer } from '../mcp-servers/telemetry/src/http.js';

const erpPort = Number(process.env.ERP_MCP_PORT) || 3001;
const telemetryPort = Number(process.env.TELEMETRY_MCP_PORT) || 3002;

const host = process.env.MCP_HOST || '0.0.0.0';

startErpHttpServer(erpPort, host);
startTelemetryHttpServer(telemetryPort, host);

console.log(
  `✅ Both MCP Servers running:\n   - ERP MCP: http://${host}:${erpPort}/sse\n   - Telemetry MCP: http://${host}:${telemetryPort}/sse`
);
