import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPT_PATH = path.resolve(__dirname, '../../../../scripts/cost-optimization.py');

export const runCostOptimizationSchema = {
  sku: z
    .string()
    .optional()
    .default('SKU-4471')
    .describe('SKU identifier to run cost and multi-criteria optimization for'),
  units: z
    .number()
    .optional()
    .default(500)
    .describe('Order batch quantity in units (defaults to 500)'),
  candidates: z
    .array(
      z.object({
        supplier_id: z.number().optional(),
        supplier_name: z.string(),
        region: z.string().optional(),
        unit_cost: z.number(),
        lead_time_days: z.number(),
        reliability_score: z.number(),
        carrier_allocated: z.string().optional(),
        carrier_rate_teu: z.number().optional(),
      })
    )
    .optional()
    .describe('Optional custom alternate suppliers list to optimize'),
};

export async function handleRunCostOptimization(params?: {
  sku?: string;
  units?: number;
  candidates?: any[];
}) {
  const sku = params?.sku || 'SKU-4471';
  const units = params?.units || 500;

  const args = ['--sku', sku, '--units', String(units), '--json'];

  if (params?.candidates && params.candidates.length > 0) {
    args.push('--input', JSON.stringify(params.candidates));
  }

  const { stdout, stderr } = await execFileAsync('python3', [SCRIPT_PATH, ...args], {
    timeout: 15000,
  });

  if (stderr && stderr.trim()) {
    console.error('Python optimization script stderr:', stderr);
  }

  const result = JSON.parse(stdout);
  const ranked = result.ranked_suppliers || [];

  // Generate ASCII summary table for human reading
  const tableRows = ranked.map((r: any) => {
    const status = r.eligible
      ? r.rank === 1
        ? '✅ Recommended (Top Rank)'
        : '✅ Compliant'
      : `❌ Ineligible (${r.violations?.join(', ') || 'Violates SOP'})`;
    return `| ${r.rank} | ${r.supplier_name} | $${r.landed_cost.toFixed(2)} | ${r.lead_time_days}d | ${r.reliability_score.toFixed(2)} | ${r.composite_score.toFixed(4)} | ${status} |`;
  });

  const markdownTable = [
    '| Rank | Supplier Name | Landed Cost | Lead Time | Reliability | Composite Score | Status |',
    '|:---:|:---|:---:|:---:|:---:|:---:|:---|',
    ...tableRows,
  ].join('\n');

  const topPick = ranked.find((r: any) => r.eligible) || ranked[0];

  return {
    success: true,
    sku,
    order_units: units,
    weights: { cost: 0.4, lead_time: 0.3, reliability: 0.3 },
    top_recommendation: topPick
      ? {
          supplier_name: topPick.supplier_name,
          landed_cost: topPick.landed_cost,
          lead_time_days: topPick.lead_time_days,
          reliability_score: topPick.reliability_score,
          composite_score: topPick.composite_score,
        }
      : null,
    ranked_suppliers: ranked,
    markdown_table: markdownTable,
  };
}
