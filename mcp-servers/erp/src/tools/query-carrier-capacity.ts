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
    .optional()
    .describe(
      'Name or ID of carrier to query (e.g. "maersk-pacific", "evergreen-express", "cma-cgm-asia")'
    ),
  carrier_id: z
    .string()
    .optional()
    .describe('Alias for carrier name or ID (e.g. "maersk-pacific", "evergreen-express", "cma-cgm-asia")'),
  input: z
    .any()
    .optional()
    .describe('Nested input object if forwarded from subagent tool proxy'),
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
  carrier?: string;
  carrier_id?: string;
  input?: any;
  route_corridor?: string;
}) {
  const rawCarrier =
    params.carrier ||
    params.carrier_id ||
    params.input?.carrier ||
    params.input?.carrier_id ||
    (typeof params.input === 'string' ? params.input : '') ||
    '';

  if (!rawCarrier) {
    throw new Error(
      'Missing required carrier parameter. Please specify carrier (e.g. "maersk-pacific", "evergreen-express", "cma-cgm-asia").'
    );
  }

  const normalizedKey = rawCarrier.toLowerCase().trim();
  const canonicalId = CARRIER_ALIASES[normalizedKey];

  if (!canonicalId) {
    throw new Error(
      `Unknown carrier "${rawCarrier}". Available carrier options are: "maersk-pacific", "evergreen-express", "cma-cgm-asia".`
    );
  }

  const filePath = path.join(CARRIER_FIXTURES_DIR, `${canonicalId}.json`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Carrier capacity profile fixture not found at: ${filePath}`);
  }

  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const requestedCorridor = params.route_corridor || params.input?.route_corridor;
  if (requestedCorridor) {
    const requested = String(requestedCorridor).toLowerCase().trim();
    const actual = data.routing_corridor.toLowerCase();
    const words = requested.split(/[\s,/]+/).filter(Boolean);
    const matches = actual.includes(requested) || words.some((w: string) => actual.includes(w));

    if (!matches) {
      throw new Error(
        `Carrier "${data.carrier_name}" does not service requested route corridor "${requestedCorridor}". Serviced corridor is: "${data.routing_corridor}".`
      );
    }
  }

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
    corridor_matched: Boolean(params.route_corridor),
    vessel_status: data.vessel_status,
    notes: data.notes,
    queried_at: new Date().toISOString(),
  };
}
