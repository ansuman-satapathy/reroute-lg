import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { assessDisruptionSchema, handleAssessDisruption } from './tools/assess-disruption.js';
import { handleGetNewsDisruptions, newsDisruptionsSchema } from './tools/news.js';
import { handleGetWeatherAlerts, weatherAlertsSchema } from './tools/weather.js';

const __filename = fileURLToPath(import.meta.url);

export function createTelemetryMcpServer(): McpServer {
  const server = new McpServer({
    name: 'telemetry-mcp',
    version: '1.0.0',
  });

  // 1. get_weather_alerts (FR-6, FR-8: Read-only, live Open-Meteo marine weather)
  server.tool(
    'get_weather_alerts',
    'Fetch real-time marine weather metrics and disruption alerts for a geographic port/region using Open-Meteo.',
    weatherAlertsSchema,
    { readOnlyHint: true },
    async (args) => {
      try {
        const result = await handleGetWeatherAlerts(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error fetching weather telemetry: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  // 2. get_news_disruptions (FR-7, FR-8: Read-only, live public maritime RSS feed)
  server.tool(
    'get_news_disruptions',
    'Fetch breaking supply-chain and maritime news disruptions (typhoons, port closures, labor strikes) for a region.',
    newsDisruptionsSchema,
    { readOnlyHint: true },
    async (args) => {
      try {
        const result = await handleGetNewsDisruptions(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error fetching news telemetry: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  // 3. assess_disruption (FR-8: Read-only, composite signal aggregation)
  server.tool(
    'assess_disruption',
    'Evaluate overall supply-chain disruption severity by synthesizing live weather metrics and news feeds for a region.',
    assessDisruptionSchema,
    { readOnlyHint: true },
    async (args) => {
      try {
        const result = await handleAssessDisruption(args);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error assessing disruption: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

export async function startServer() {
  const server = createTelemetryMcpServer();
  const transport = new StdioServerTransport();

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await server.close();
    process.exit(0);
  });

  await server.connect(transport);
  console.error('✅ Telemetry MCP Server connected via stdio transport');
}

if (process.argv[1] === __filename) {
  startServer().catch((err) => {
    console.error('❌ Telemetry MCP Server failed to start:', err);
    process.exit(1);
  });
}
