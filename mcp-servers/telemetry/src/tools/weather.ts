import { z } from 'zod';
import type { DisruptionSeverity, DisruptionSignal, WeatherAlertResponse } from '../types.js';

export const weatherAlertsSchema = {
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .describe('Latitude coordinate of the maritime region / port (e.g. 30.6 for East China Sea)'),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe('Longitude coordinate of the maritime region / port (e.g. 126.0 for East China Sea)'),
  region_name: z
    .string()
    .optional()
    .default('East China Sea')
    .describe('Human-readable geographical region name (e.g. "East China Sea")'),
};

/**
 * Maps WMO Weather interpretation codes to textual descriptions
 */
function decodeWeatherCode(code: number): string {
  if (code === 0) return 'Clear sky';
  if ([1, 2, 3].includes(code)) return 'Partly cloudy / overcast';
  if ([45, 48].includes(code)) return 'Fog / depositing rime fog';
  if ([51, 53, 55].includes(code)) return 'Drizzle';
  if ([61, 63, 65].includes(code)) return 'Rain (moderate to heavy)';
  if ([71, 73, 75].includes(code)) return 'Snow fall';
  if ([80, 81, 82].includes(code)) return 'Rain showers';
  if ([95, 96, 99].includes(code)) return 'Thunderstorm / Severe convective storm';
  return 'Unspecified atmospheric disturbance';
}

export async function handleGetWeatherAlerts(params: {
  latitude: number;
  longitude: number;
  region_name?: string;
}): Promise<WeatherAlertResponse> {
  const region = params.region_name ?? 'East China Sea';
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${params.latitude}&longitude=${params.longitude}&current=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m,weather_code&hourly=wind_speed_10m,precipitation&forecast_days=3`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'TrueForge-Disruption-Triage-Agent/1.0',
      },
    });

    if (!response.ok) {
      throw new Error(`Open-Meteo API returned HTTP status ${response.status}`);
    }

    const data = (await response.json()) as any;
    const current = data.current || {};
    const windSpeed = current.wind_speed_10m ?? 0;
    const windGusts = current.wind_gusts_10m ?? 0;
    const precipitation = current.precipitation ?? 0;
    const weatherCode = current.weather_code ?? 0;
    const weatherCondition = decodeWeatherCode(weatherCode);

    // Compute maritime disruption severity thresholds
    let severity: DisruptionSeverity = 'low';
    let summary = `Favorable maritime conditions. Wind: ${windSpeed} km/h, gusts: ${windGusts} km/h, rain: ${precipitation} mm. ${weatherCondition}.`;

    if (windGusts >= 60 || precipitation >= 25 || [95, 96, 99].includes(weatherCode)) {
      severity = 'high';
      summary = `CRITICAL MARITIME DISRUPTION: Severe gale/storm conditions detected in ${region}. Wind gusts of ${windGusts} km/h, precipitation ${precipitation} mm. High risk of vessel diversions and port terminal shutdown.`;
    } else if (windGusts >= 40 || precipitation >= 10 || [65, 75, 82].includes(weatherCode)) {
      severity = 'medium';
      summary = `ELEVATED WEATHER RISK: Moderate maritime disruption in ${region}. Wind gusts of ${windGusts} km/h, precipitation ${precipitation} mm. Potential container handling delays and slower transit speeds.`;
    }

    const signal: DisruptionSignal = {
      type: 'weather',
      severity,
      region,
      title: `${severity.toUpperCase()} Weather Alert: ${region}`,
      summary,
      details: {
        coordinates: { latitude: params.latitude, longitude: params.longitude },
        wind_speed_kmh: windSpeed,
        wind_gusts_kmh: windGusts,
        precipitation_mm: precipitation,
        weather_code: weatherCode,
        weather_condition: weatherCondition,
        recorded_at: current.time ?? new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
      source: 'Open-Meteo Live Marine Forecast',
      confidence: 0.95,
    };

    return {
      total_signals: 1,
      region,
      coordinates: {
        latitude: params.latitude,
        longitude: params.longitude,
      },
      signals: [signal],
      raw_current_metrics: {
        temperature_c: current.temperature_2m ?? 0,
        wind_speed_kmh: windSpeed,
        wind_gusts_kmh: windGusts,
        precipitation_mm: precipitation,
        weather_code: weatherCode,
      },
    };
  } catch (err: any) {
    // Graceful fallback with transparent error indication (e.g. offline sandbox or network drop)
    const fallbackSignal: DisruptionSignal = {
      type: 'weather',
      severity: 'medium',
      region,
      title: `Weather Telemetry Notice: ${region}`,
      summary: `Live Open-Meteo telemetry query encountered connectivity limitation: ${err.message}. Maritime advisory monitoring active.`,
      details: {
        error: err.message,
        coordinates: { latitude: params.latitude, longitude: params.longitude },
      },
      timestamp: new Date().toISOString(),
      source: 'Open-Meteo (Offline Fallback)',
      confidence: 0.6,
    };

    return {
      total_signals: 1,
      region,
      coordinates: {
        latitude: params.latitude,
        longitude: params.longitude,
      },
      signals: [fallbackSignal],
    };
  }
}
