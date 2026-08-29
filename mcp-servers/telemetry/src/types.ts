/**
 * Telemetry MCP Server - Domain Types
 * Defines structured disruption signal formats required by FR-8
 */

export type DisruptionType = 'weather' | 'news' | 'composite';
export type DisruptionSeverity = 'low' | 'medium' | 'high';

export interface DisruptionSignal {
  type: DisruptionType;
  severity: DisruptionSeverity;
  region: string;
  title: string;
  summary: string;
  details: Record<string, any>;
  timestamp: string;
  source: string;
  confidence: number;
}

export interface WeatherAlertResponse {
  total_signals: number;
  region: string;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  signals: DisruptionSignal[];
  raw_current_metrics?: {
    temperature_c: number;
    wind_speed_kmh: number;
    wind_gusts_kmh: number;
    precipitation_mm: number;
    weather_code: number;
  };
}

export interface NewsDisruptionResponse {
  total_signals: number;
  region: string;
  query_used: string;
  signals: DisruptionSignal[];
}

export interface CompositeAssessmentResponse {
  region: string;
  overall_severity: DisruptionSeverity;
  is_disrupted: boolean;
  signals: DisruptionSignal[];
  recommendation: string;
}
