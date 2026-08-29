import { z } from 'zod';
import type { DisruptionSeverity, DisruptionSignal, NewsDisruptionResponse } from '../types.js';

export const newsDisruptionsSchema = {
  region: z
    .string()
    .min(1)
    .describe('Geographical region or port to monitor for supply-chain news (e.g. "East China Sea", "Ningbo", "Shanghai")'),
  keywords: z
    .array(z.string())
    .optional()
    .default(['port', 'shipping', 'typhoon', 'delay', 'closure'])
    .describe('Supply-chain and disruption keywords to filter articles by'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .default(5)
    .describe('Maximum number of news disruption items to return (default: 5)'),
};

/**
 * Strips HTML tags and decodes common XML entities
 */
function cleanText(raw: string): string {
  return raw
    .replace(/<[^>]*>?/gm, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Safely converts arbitrary RSS publication date strings to ISO-8601
 * Guarantees that invalid date formats never throw RangeError (Fix for Qodo #3)
 */
export function safeParseIsoDate(rawDate?: string): string {
  if (!rawDate) return new Date().toISOString();
  try {
    const timestamp = Date.parse(rawDate);
    if (!isNaN(timestamp)) {
      return new Date(timestamp).toISOString();
    }
  } catch {}
  return new Date().toISOString();
}

/**
 * Classifies supply-chain news severity based on disruption impact indicators.
 * Accounts for resolution and negation phrases (Fix for Qodo #5).
 */
export function classifyNewsSeverity(text: string): { severity: DisruptionSeverity; score: number } {
  const lower = text.toLowerCase();

  // Check for resolved / negated indicators (Fix for Qodo #5)
  // Headlines like "ports reopen as storm weakens" or "strike called off" should NOT trigger high alerts
  const resolvedIndicators = [
    'reopen',
    'reopens',
    'reopened',
    'avoided',
    'averted',
    'called off',
    'lifted',
    'weakens',
    'weakened',
    'downgraded',
    'resumes',
    'resumed',
    'normalized',
    'back to normal',
  ];

  const hasResolution = resolvedIndicators.some((term) => lower.includes(term));

  if (hasResolution) {
    return { severity: 'low', score: 0.8 };
  }

  const highIndicators = [
    'shut down',
    'shutdown',
    'closed',
    'closure',
    'suspended',
    'typhoon',
    'hurricane',
    'strike',
    'embargo',
    'blocked',
    'blockade',
    'evacuation',
    'catastrophic',
  ];

  const mediumIndicators = [
    'delay',
    'delays',
    'congestion',
    'slowdown',
    'warning',
    'storm',
    'gale',
    'diverted',
    'disruption',
    'bottleneck',
    'backlog',
  ];

  for (const word of highIndicators) {
    if (lower.includes(word)) {
      return { severity: 'high', score: 0.9 };
    }
  }

  for (const word of mediumIndicators) {
    if (lower.includes(word)) {
      return { severity: 'medium', score: 0.75 };
    }
  }

  return { severity: 'low', score: 0.5 };
}

export async function handleGetNewsDisruptions(params: {
  region: string;
  keywords?: string[];
  limit?: number;
}): Promise<NewsDisruptionResponse> {
  const keywords = params.keywords && params.keywords.length > 0
    ? params.keywords
    : ['port', 'shipping', 'typhoon', 'delay', 'closure'];
  const limit = params.limit ?? 5;

  const searchQuery = `${params.region} (${keywords.join(' OR ')})`;
  const rssUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(searchQuery)}&hl=en-US&gl=US&ceid=US:en`;

  try {
    const response = await fetch(rssUrl, {
      signal: AbortSignal.timeout(10000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DisruptionTriageBot/1.0; +https://trueforge.dev)',
      },
    });

    if (!response.ok) {
      throw new Error(`News RSS feed returned HTTP status ${response.status}`);
    }

    const xml = await response.text();
    const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];

    const signals: DisruptionSignal[] = [];

    for (const itemXml of itemMatches) {
      if (signals.length >= limit) break;

      const titleMatch = itemXml.match(/<title>([\s\S]*?)<\/title>/);
      const linkMatch = itemXml.match(/<link>([\s\S]*?)<\/link>/);
      const pubDateMatch = itemXml.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
      const sourceMatch = itemXml.match(/<source[^>]*>([\s\S]*?)<\/source>/);

      const title = titleMatch ? cleanText(titleMatch[1]) : 'Supply Chain Notice';
      const link = linkMatch ? cleanText(linkMatch[1]) : '';
      // Fix for Qodo #3: Safe ISO parsing prevents malformed external dates from aborting the feed
      const pubDate = safeParseIsoDate(pubDateMatch ? cleanText(pubDateMatch[1]) : undefined);
      const source = sourceMatch ? cleanText(sourceMatch[1]) : 'Public Maritime RSS Feed';

      // Fix for Qodo #5: Accurate classification with negation/resolution awareness
      const { severity, score } = classifyNewsSeverity(title);

      signals.push({
        type: 'news',
        severity,
        region: params.region,
        title,
        summary: `Supply-chain news signal detected for ${params.region}: "${title}". Assessed as ${severity.toUpperCase()} impact risk.`,
        details: {
          is_telemetry_unavailable: false,
          article_title: title,
          url: link,
          published_date: pubDate,
          publisher: source,
          search_query: searchQuery,
        },
        timestamp: pubDate,
        source,
        confidence: score,
      });
    }

    // If zero news items matched the specific query, provide a neutral baseline signal
    if (signals.length === 0) {
      signals.push({
        type: 'news',
        severity: 'low',
        region: params.region,
        title: `No active breaking disruptions reported for ${params.region}`,
        summary: `Automated news feed scan completed for query "${searchQuery}". No critical port closures or disruptions found in current news items.`,
        details: { is_telemetry_unavailable: false, search_query: searchQuery },
        timestamp: new Date().toISOString(),
        source: 'Public Maritime RSS Feed',
        confidence: 0.7,
      });
    }

    return {
      total_signals: signals.length,
      region: params.region,
      query_used: searchQuery,
      signals,
    };
  } catch (err: any) {
    // Fix for Qodo #2: Outages are marked with severity 'low' and is_telemetry_unavailable: true
    const fallbackSignal: DisruptionSignal = {
      type: 'news',
      severity: 'low',
      region: params.region,
      title: `News Telemetry Offline: ${params.region}`,
      summary: `News feed telemetry unavailable due to connectivity limitation (${err.message}). No active disruption verified.`,
      details: { is_telemetry_unavailable: true, error: err.message, query: searchQuery },
      timestamp: new Date().toISOString(),
      source: 'Public Maritime RSS Feed (Offline Notice)',
      confidence: 0.0,
    };

    return {
      total_signals: 1,
      region: params.region,
      query_used: searchQuery,
      signals: [fallbackSignal],
    };
  }
}
