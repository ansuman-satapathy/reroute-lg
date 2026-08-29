import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getErpDb } from '../db.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SCRIPT_PATH = path.resolve(__dirname, '../../../../scripts/cost-optimization.py');

export const runCostOptimizationSchema = {
  sku: z
    .string()
    .min(1)
    .optional()
    .default('SKU-4471')
    .describe('SKU identifier to run cost and multi-criteria optimization for'),
  units: z
    .number()
    .int()
    .positive()
    .optional()
    .default(500)
    .describe('Order batch quantity in units (defaults to 500)'),
  candidates: z
    .array(
      z.object({
        supplier_id: z.number().int().positive().optional(),
        supplier_name: z.string().min(1),
        region: z.string().optional(),
        unit_cost: z.number().positive(),
        lead_time_days: z.number().int().positive(),
        reliability_score: z.number().min(0).max(1),
        carrier_allocated: z.string().optional(),
        carrier_rate_teu: z.number().nonnegative().optional(),
      })
    )
    .optional()
    .describe('Optional custom alternate suppliers list to optimize'),
};

/**
 * Native Node.js MCDA cost-optimization fallback (fixes Qodo #7 for zero-dependency portability)
 */
function runNativeNodeOptimization(
  candidates: any[],
  primary: any,
  units: number
) {
  const maxCostCeiling = primary.primary_unit_cost * 1.5;
  const daysOfSupply = primary.days_of_supply ?? 14;

  const evaluated = candidates.map((c: any) => {
    const unitCost = Number(c.unit_cost);
    const leadTime = Number(c.lead_time_days);
    const rel = Number(c.reliability_score);
    const carrierRate = Number(c.carrier_rate_teu || 0);
    const landedCost = Number((unitCost + (carrierRate > 0 ? carrierRate / 2500 : 0)).toFixed(2));

    const violations: string[] = [];
    if (unitCost > maxCostCeiling) {
      violations.push(`Exceeds +50% cost ceiling ($${unitCost.toFixed(2)} > $${maxCostCeiling.toFixed(2)})`);
    }
    // Fix for Qodo #4: lead_time >= days_of_supply violates arrival-before-stockout
    if (leadTime >= daysOfSupply) {
      violations.push(`Exceeds stockout window (${leadTime}d >= ${daysOfSupply}d DoS)`);
    }
    if (rel < 0.75) {
      violations.push(`Reliability below 0.75 floor (${rel.toFixed(2)})`);
    }
    if (leadTime > 30) {
      violations.push(`Lead time exceeds 30-day cap (${leadTime}d)`);
    }

    const eligible = violations.length === 0;
    return {
      supplier_id: c.supplier_id,
      supplier_name: c.supplier_name,
      region: c.region || 'Global',
      unit_cost: unitCost,
      landed_cost: landedCost,
      lead_time_days: leadTime,
      reliability_score: rel,
      eligible,
      violations,
      carrier: c.carrier_allocated || 'Standard',
      norm_cost: 0,
      norm_lead: 0,
      norm_rel: 0,
      composite_score: 0,
    };
  });

  const costs = evaluated.map((e: any) => e.landed_cost);
  const leads = evaluated.map((e: any) => e.lead_time_days);
  const rels = evaluated.map((e: any) => e.reliability_score);

  const minCost = Math.min(...costs), maxCost = Math.max(...costs);
  const minLead = Math.min(...leads), maxLead = Math.max(...leads);
  const minRel = Math.min(...rels), maxRel = Math.max(...rels);

  for (const e of evaluated) {
    const normCost = maxCost === minCost ? 1.0 : (maxCost - e.landed_cost) / (maxCost - minCost);
    const normLead = maxLead === minLead ? 1.0 : (maxLead - e.lead_time_days) / (maxLead - minLead);
    const normRel = maxRel === minRel ? 1.0 : (e.reliability_score - minRel) / (maxRel - minRel);

    const baseScore = 0.4 * normCost + 0.3 * normLead + 0.3 * normRel;
    e.norm_cost = Number(normCost.toFixed(4));
    e.norm_lead = Number(normLead.toFixed(4));
    e.norm_rel = Number(normRel.toFixed(4));
    e.composite_score = Number((e.eligible ? baseScore : baseScore * 0.15).toFixed(4));
  }

  const ranked = evaluated.sort((a: any, b: any) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    return b.composite_score - a.composite_score;
  });

  ranked.forEach((item: any, idx: number) => {
    item.rank = idx + 1;
  });

  return ranked;
}

export async function handleRunCostOptimization(params?: {
  sku?: string;
  units?: number;
  candidates?: any[];
}) {
  const sku = params?.sku || 'SKU-4471';
  const units = params?.units || 500;

  let candidates = params?.candidates;
  let primaryInfo: any = null;

  const db = await getErpDb();
  const item = db
    .prepare(
      `SELECT i.*, s.name as primary_supplier_name, s.unit_cost as primary_unit_cost,
              s.reliability_score as primary_reliability_score, s.lead_time_days as primary_lead_time_days
       FROM inventory i
       LEFT JOIN suppliers s ON i.primary_supplier_id = s.id
       WHERE i.sku = ?`
    )
    .get(sku) as any;

  if (!item) {
    throw new Error(`Item with SKU "${sku}" not found in ERP inventory`);
  }

  const burnRate = item.daily_burn_rate || 10;
  const daysOfSupply = Math.floor(item.current_stock / burnRate);

  primaryInfo = {
    sku: item.sku,
    primary_supplier_name: item.primary_supplier_name || 'Primary Supplier',
    primary_unit_cost: item.primary_unit_cost ?? 42.5,
    current_stock: item.current_stock,
    daily_burn_rate: burnRate,
    days_of_supply: daysOfSupply,
  };

  // Fix for Qodo #1: Query ERP catalog for alternate offerings if candidates not provided
  if (!candidates || candidates.length === 0) {
    const offerings = db
      .prepare(
        `SELECT sc.supplier_id, s.name as supplier_name, s.region,
                sc.unit_cost, sc.lead_time_days, sc.reliability_score
         FROM supplier_catalog sc
         JOIN suppliers s ON sc.supplier_id = s.id
         WHERE sc.sku = ? AND sc.supplier_id != ?`
      )
      .all(sku, item.primary_supplier_id) as any[];

    if (offerings.length === 0) {
      throw new Error(`No alternate supplier offerings found in ERP catalog for SKU "${sku}"`);
    }

    candidates = offerings.map((o: any) => ({
      supplier_id: o.supplier_id,
      supplier_name: o.supplier_name,
      region: o.region,
      unit_cost: o.unit_cost,
      lead_time_days: o.lead_time_days,
      reliability_score: o.reliability_score,
      carrier_allocated:
        o.supplier_id === 2
          ? 'Maersk Pacific Lines'
          : o.supplier_id === 4
            ? 'Evergreen Express Maritime'
            : 'Standard Rail/Feeder',
      carrier_rate_teu:
        o.supplier_id === 2 ? 2850 : o.supplier_id === 4 ? 1920 : 1600,
    }));
  }

  const payload = {
    primary: primaryInfo,
    candidates,
  };

  let ranked: any[] = [];

  // Try running via python3, fallback to native Node.js optimization if python3 not available (Qodo #7)
  try {
    const args = ['--sku', sku, '--units', String(units), '--json', '--input', JSON.stringify(payload)];
    const { stdout } = await execFileAsync('python3', [SCRIPT_PATH, ...args], {
      timeout: 15000,
    });
    const result = JSON.parse(stdout);
    ranked = result.ranked_suppliers || [];
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.warn('⚠️ python3 not found on host. Using managed native Node.js MCDA optimizer fallback.');
      ranked = runNativeNodeOptimization(candidates, primaryInfo || { primary_unit_cost: 42.5, days_of_supply: 14 }, units);
    } else {
      throw new Error(`Cost optimization execution failed: ${err.message}`);
    }
  }

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

  // Fix for Qodo #3: Return top recommendation ONLY if eligible; return null when no candidate meets guardrails
  const eligiblePicks = ranked.filter((r: any) => r.eligible);
  const topPick = eligiblePicks.length > 0 ? eligiblePicks[0] : null;

  return {
    success: true,
    sku,
    order_units: units,
    weights: { cost: 0.4, lead_time: 0.3, reliability: 0.3 },
    top_recommendation: topPick
      ? {
          supplier_id: topPick.supplier_id,
          supplier_name: topPick.supplier_name,
          landed_cost: topPick.landed_cost,
          lead_time_days: topPick.lead_time_days,
          reliability_score: topPick.reliability_score,
          composite_score: topPick.composite_score,
          eligible: true,
        }
      : null,
    recommendation_status: topPick
      ? `Top recommendation: ${topPick.supplier_name} (Rank #${topPick.rank})`
      : 'No candidate supplier meets all operational guardrails and arrival windows',
    ranked_suppliers: ranked,
    markdown_table: markdownTable,
  };
}
