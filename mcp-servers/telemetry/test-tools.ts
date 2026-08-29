import { createTelemetryMcpServer } from './src/index.js';
import { handleAssessDisruption } from './src/tools/assess-disruption.js';
import { classifyNewsSeverity, handleGetNewsDisruptions, safeParseIsoDate } from './src/tools/news.js';
import { handleGetWeatherAlerts } from './src/tools/weather.js';

async function runTelemetryTests() {
  console.log('🧪 Starting Telemetry MCP Server Test Suite (Ticket #04 + Qodo Assertions)...');

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

  // 2. Test Safe Date Parsing (Qodo #3)
  console.log('\n🔍 Testing safeParseIsoDate with invalid inputs...');
  const invalidDateParsed = safeParseIsoDate('completely-invalid-date-string');
  if (typeof invalidDateParsed !== 'string' || isNaN(Date.parse(invalidDateParsed))) {
    throw new Error('❌ safeParseIsoDate failed to return a valid ISO fallback string');
  }
  const undefinedDateParsed = safeParseIsoDate(undefined);
  if (typeof undefinedDateParsed !== 'string') {
    throw new Error('❌ safeParseIsoDate failed on undefined input');
  }
  console.log('✅ Qodo #3 Fixed: Invalid date strings safely resolved without throwing RangeError');

  // 3. Test Negation / Resolution Classifier (Qodo #5)
  console.log('\n🔍 Testing headline negation and resolution classification...');
  const reopenedHeadline = classifyNewsSeverity('East China Sea ports reopen as typhoon weakens');
  if (reopenedHeadline.severity !== 'low') {
    throw new Error(`❌ Expected 'low' for reopened port headline, got: ${reopenedHeadline.severity}`);
  }

  const avoidedHeadline = classifyNewsSeverity('Major maritime strike avoided following union agreement');
  if (avoidedHeadline.severity !== 'low') {
    throw new Error(`❌ Expected 'low' for strike avoided headline, got: ${avoidedHeadline.severity}`);
  }

  const activeDisruptionHeadline = classifyNewsSeverity('Super Typhoon Muifa forces emergency port closure across Shanghai');
  if (activeDisruptionHeadline.severity !== 'high') {
    throw new Error(`❌ Expected 'high' for active emergency closure headline, got: ${activeDisruptionHeadline.severity}`);
  }
  console.log('✅ Qodo #5 Fixed: Resolved/negated headlines classified as low; active closures classified as high');

  // 4. Test Live Open-Meteo Weather Query for East China Sea
  console.log('\n🔍 Testing live get_weather_alerts({ latitude: 30.6, longitude: 126.0 })...');
  const weatherResult = await handleGetWeatherAlerts({
    latitude: 30.6,
    longitude: 126.0,
    region_name: 'East China Sea',
  });

  if (weatherResult.signals.length === 0) {
    throw new Error('❌ Expected at least 1 weather disruption signal');
  }

  const weatherSignal = weatherResult.signals[0];
  console.log(`✅ Live weather signal received: [${weatherSignal.severity.toUpperCase()}] ${weatherSignal.summary}`);

  // 5. Test Live News Disruption Query
  console.log('\n🔍 Testing live get_news_disruptions({ region: "East China Sea" })...');
  const newsResult = await handleGetNewsDisruptions({
    region: 'East China Sea',
    keywords: ['port', 'shipping', 'typhoon'],
    limit: 3,
  });

  if (newsResult.signals.length === 0) {
    throw new Error('❌ Expected at least 1 news disruption signal');
  }
  console.log(`✅ Live news signals received: ${newsResult.signals.length} articles`);

  // 6. Test Composite Assessment
  console.log('\n🔍 Testing assess_disruption({ region: "East China Sea" })...');
  const assessment = await handleAssessDisruption({ region: 'East China Sea' });

  if (typeof assessment.is_disrupted !== 'boolean') {
    throw new Error('❌ Expected boolean is_disrupted');
  }
  console.log(`✅ Composite assessment complete: Overall Severity=${assessment.overall_severity.toUpperCase()}, IsDisrupted=${assessment.is_disrupted}`);

  console.log('\n🎉 ALL Ticket #04 acceptance tests & Qodo review assertions PASSED successfully!');
}

runTelemetryTests().catch((err) => {
  console.error('\n❌ Telemetry MCP Server test failed:', err);
  process.exit(1);
});
