import { createTelemetryMcpServer } from './src/index.js';
import { handleAssessDisruption } from './src/tools/assess-disruption.js';
import { handleGetNewsDisruptions } from './src/tools/news.js';
import { handleGetWeatherAlerts } from './src/tools/weather.js';

async function runTelemetryTests() {
  console.log('🧪 Starting Telemetry MCP Server Test Suite (Ticket #04)...');

  // 1. Verify McpServer Tool Registrations and Annotations
  const server = createTelemetryMcpServer();
  const registered = (server as any)._registeredTools;
  const toolNames = Object.keys(registered);

  console.log('🔍 Registered tools in McpServer:', toolNames);

  const expectedTools = ['get_weather_alerts', 'get_news_disruptions', 'assess_disruption'];
  for (const expected of expectedTools) {
    if (!toolNames.includes(expected)) {
      throw new Error(`❌ Missing expected tool registration: ${expected}`);
    }
    const tool = registered[expected];
    if (!tool.annotations?.readOnlyHint) {
      throw new Error(`❌ Tool ${expected} must have readOnlyHint: true annotation`);
    }
  }
  console.log('✅ Criteria 1 Passed: All telemetry tools registered with readOnlyHint: true');

  // 2. Test Live Open-Meteo Weather Query for East China Sea (lat: 30.6, lon: 126.0)
  console.log('\n🔍 Testing get_weather_alerts({ latitude: 30.6, longitude: 126.0 })...');
  const weatherResult = await handleGetWeatherAlerts({
    latitude: 30.6,
    longitude: 126.0,
    region_name: 'East China Sea',
  });

  if (weatherResult.signals.length === 0) {
    throw new Error('❌ Expected at least 1 weather disruption signal');
  }

  const weatherSignal = weatherResult.signals[0];
  if (!['weather', 'composite'].includes(weatherSignal.type)) {
    throw new Error(`❌ Invalid signal type: ${weatherSignal.type}`);
  }
  if (!['low', 'medium', 'high'].includes(weatherSignal.severity)) {
    throw new Error(`❌ Invalid severity level: ${weatherSignal.severity}`);
  }
  if (weatherSignal.region !== 'East China Sea') {
    throw new Error(`❌ Expected region East China Sea, got ${weatherSignal.region}`);
  }

  console.log('✅ Criteria 2 Passed: Real Open-Meteo marine data received for East China Sea:');
  console.log(`   - Severity: ${weatherSignal.severity.toUpperCase()}`);
  console.log(`   - Summary: ${weatherSignal.summary}`);
  if (weatherResult.raw_current_metrics) {
    console.log(`   - Current Wind: ${weatherResult.raw_current_metrics.wind_speed_kmh} km/h (Gusts: ${weatherResult.raw_current_metrics.wind_gusts_kmh} km/h)`);
    console.log(`   - Temperature: ${weatherResult.raw_current_metrics.temperature_c}°C | Rain: ${weatherResult.raw_current_metrics.precipitation_mm} mm`);
  }

  // 3. Test Live News Disruption Query
  console.log('\n🔍 Testing get_news_disruptions({ region: "East China Sea", keywords: ["port", "typhoon", "shipping"] })...');
  const newsResult = await handleGetNewsDisruptions({
    region: 'East China Sea',
    keywords: ['port', 'typhoon', 'shipping'],
    limit: 3,
  });

  if (newsResult.signals.length === 0) {
    throw new Error('❌ Expected at least 1 news disruption signal');
  }

  const firstNews = newsResult.signals[0];
  if (firstNews.type !== 'news') {
    throw new Error(`❌ Expected type 'news', got ${firstNews.type}`);
  }
  if (!['low', 'medium', 'high'].includes(firstNews.severity)) {
    throw new Error(`❌ Invalid severity level: ${firstNews.severity}`);
  }

  console.log(`✅ Criteria 3 Passed: Real news RSS data received (${newsResult.signals.length} article signal(s)):`);
  for (const s of newsResult.signals) {
    console.log(`   - [${s.severity.toUpperCase()}] ${s.title.slice(0, 80)}... (${s.source})`);
  }

  // 4. Test Composite Assessment
  console.log('\n🔍 Testing assess_disruption({ region: "East China Sea" })...');
  const assessment = await handleAssessDisruption({ region: 'East China Sea' });

  if (!['low', 'medium', 'high'].includes(assessment.overall_severity)) {
    throw new Error(`❌ Invalid assessment overall_severity: ${assessment.overall_severity}`);
  }
  if (assessment.signals.length < 2) {
    throw new Error(`❌ Expected combined weather + news signals, got ${assessment.signals.length}`);
  }

  console.log('✅ Criteria 4 Passed: Composite disruption assessment synthesized successfully:');
  console.log(`   - Overall Severity: ${assessment.overall_severity.toUpperCase()}`);
  console.log(`   - Recommendation: ${assessment.recommendation}`);

  console.log('\n🎉 ALL Ticket #04 acceptance tests PASSED successfully!');
}

runTelemetryTests().catch((err) => {
  console.error('\n❌ Telemetry MCP Server test failed:', err);
  process.exit(1);
});
