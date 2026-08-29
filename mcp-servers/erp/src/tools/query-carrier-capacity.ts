import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CARRIER_FIXTURES_DIR = path.resolve(__dirname, '../../../../fixtures/carriers');

export const queryCarrierCapacitySchema = {
  carrier: z
    .string()
    .min(1)
    .describe(
      'Name or ID of carrier to query (e.g. "maersk-pacific", "evergreen-express", "cma-cgm-asia")'
    ),
  route_corridor: z
    .string()
    .optional()
    .describe('Optional origin-destination corridor filter (e.g. "Trans-Pacific", "Southeast Asia")'),
};

const CARRIER_ALIASES: Record<string, string> = {
  maersk: 'maersk-pacific',
  'maersk-pacific': 'maersk-pacific',
  'maersk pacific': 'maersk-pacific',
  'maersk lines': 'maersk-pacific',
  evergreen: 'evergreen-express',
  'evergreen-express': 'evergreen-express',
  'evergreen express': 'evergreen-express',
  'evergreen maritime': 'evergreen-express',
  cma: 'cma-cgm-asia',
  'cma-cgm': 'cma-cgm-asia',
  'cma cgm': 'cma-cgm-asia',
  'cma-cgm-asia': 'cma-cgm-asia',
  'cma cgm asia': 'cma-cgm-asia',
};

export async function handleQueryCarrierCapacity(params: {
  carrier: string;
  route_corridor?: string;
}) {
  const normalizedKey = params.carrier.toLowerCase().trim();
  const canonicalId = CARRIER_ALIASES[normalizedKey];

  if (!canonicalId) {
    const validCarriers = Object.keys(CARRIER_ALIASES);
    throw new Error(
      `Unknown carrier "${params.carrier}". Available carrier options are: "maersk-pacific", "evergreen-express", "cma-cgm-asia".`
    );
  }

  const filePath = path.join(CARRIER_FIXTURES_DIR, `${canonicalId}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Carrier capacity profile fixture not found at: ${filePath}`);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  return {
    success: true,
    carrier_id: data.carrier_id,
    carrier_name: data.carrier_name,
    service_tier: data.service_tier,
    available_teu_capacity: data.available_teu_capacity,
    transit_time_days: data.transit_time_days,
    rate_per_teu_usd: data.rate_per_teu_usd,
    reliability_score: data.reliability_score,
    cutoff_window_hours: data.cutoff_window_hours,
    next_departure: data.next_departure,
    routing_corridor: data.routing_corridor,
    vessel_status: data.vessel_status,
    notes: data.notes,
    queried_at: new Date().toISOString(),
  };
}
