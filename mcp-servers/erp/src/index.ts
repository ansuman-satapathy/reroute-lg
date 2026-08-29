import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { fileURLToPath } from 'node:url';
import { handleReadInventory, readInventorySchema } from './tools/read-inventory.js';
import { handleReadPurchaseOrders, readPurchaseOrdersSchema } from './tools/read-purchase-orders.js';
import { handleReadSuppliers, readSuppliersSchema } from './tools/read-suppliers.js';

const __filename = fileURLToPath(import.meta.url);

export function createErpMcpServer(): McpServer {
  const server = new McpServer({
    name: 'erp-mcp',
    version: '1.0.0',
  });

  // 1. read_inventory (Read-only, ungated)
  server.tool(
    'read_inventory',
    'Query ERP inventory stock levels, reorder thresholds, and primary supplier details by SKU or item name.',
    readInventorySchema,
    { readOnlyHint: true },
    async (args) => {
      try {
        const result = await handleReadInventory(args);
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
              text: `Error reading inventory: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  // 2. read_suppliers (Read-only, ungated)
  server.tool(
    'read_suppliers',
    'Query supplier catalog and alternate supplier offerings including unit costs, lead times, reliability scores, and origin regions.',
    readSuppliersSchema,
    { readOnlyHint: true },
    async (args) => {
      try {
        const result = await handleReadSuppliers(args);
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
              text: `Error reading suppliers: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  // 3. read_purchase_orders (Read-only, ungated)
  server.tool(
    'read_purchase_orders',
    'Query existing purchase orders from the ERP database by status or item name.',
    readPurchaseOrdersSchema,
    { readOnlyHint: true },
    async (args) => {
      try {
        const result = await handleReadPurchaseOrders(args);
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
              text: `Error reading purchase orders: ${err.message}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

export async function startServer() {
  const server = createErpMcpServer();
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
  console.error('✅ ERP MCP Server connected via stdio transport');
}

if (process.argv[1] === __filename) {
  startServer().catch((err) => {
    console.error('❌ ERP MCP Server failed to start:', err);
    process.exit(1);
  });
}
