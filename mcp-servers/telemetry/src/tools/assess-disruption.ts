import { z } from 'zod';
import type { CompositeAssessmentResponse, DisruptionSeverity, DisruptionSignal } from '../types.js';
import { handleGetNewsDisruptions } from './news.js';
import { handleGetWeatherAlerts } from './weather.js';

export const assessDisruptionSchema = {
  region: z
    .string()
    .optional()
    .default('East China Sea')
    .describe('Geographical region to assess (e.g. "East China Sea")'),
  latitude: z
    .number()
    .optional()
    .default(30.6)
    .describe('Latitude coordinate of the regional hub (default: 30.6 for East China Sea)'),
  longitude: z
    .number()
    .optional()
    .default(126.0)
    .describe('Longitude coordinate of the regional hub (default: 126.0 for East China Sea)'),
};

export async function handleAssessDisruption(params: {
  region?: string;
  latitude?: number;
  longitude?: number;
}): Promise<CompositeAssessmentResponse> {
  const region = params.region ?? 'East China Sea';
  const latitude = params.latitude ?? 30.6;
  const longitude = params.longitude ?? 126.0;

  // Run weather and news queries in parallel
  const [weatherData, newsData] = await Promise.all([
    handleGetWeatherAlerts({ latitude, longitude, region_name: region }),
    handleGetNewsDisruptions({ region, keywords: ['port', 'shipping', 'typhoon', 'delay', 'closure'], limit: 3 }),
  ]);

  const allSignals: DisruptionSignal[] = [...weatherData.signals, ...newsData.signals];

  const hasHigh = allSignals.some((s) => s.severity === 'high');
  const hasMedium = allSignals.some((s) => s.severity === 'medium');

  let overallSeverity: DisruptionSeverity = 'low';
  if (hasHigh) {
    overallSeverity = 'high';
  } else if (hasMedium) {
    overallSeverity = 'medium';
  }

  let recommendation = 'Normal operations. No immediate rerouting required.';
  if (overallSeverity === 'high') {
    recommendation =
      'CRITICAL: Severe disruption confirmed in shipping corridor. Immediate supplier evaluation and purchase order amendment required.';
  } else if (overallSeverity === 'medium') {
    recommendation =
      'ELEVATED: Disruption indicators present. Query inventory buffer and alert logistics operations team.';
  }

  return {
    region,
    overall_severity: overallSeverity,
    is_disrupted: overallSeverity !== 'low',
    signals: allSignals,
    recommendation,
  };
}
