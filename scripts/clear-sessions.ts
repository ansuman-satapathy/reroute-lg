import { TrueForge } from '@truefoundry/trueforge-sdk';

const TRUEFORGE_BASE_URL = process.env.TRUEFORGE_BASE_URL || 'http://localhost:8790';

async function clearAllSessions() {
  console.log(`🧹 Connecting to TrueForge at: ${TRUEFORGE_BASE_URL}...`);
  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });

  const res = await client.sessions.list();
  const sessions = res.data || [];

  if (sessions.length === 0) {
    console.log('✨ No chat sessions found. Workspace is already completely clean!');
    return;
  }

  console.log(`🗑️ Deleting ${sessions.length} chat session(s)...`);
  for (const s of sessions) {
    await client.sessions.delete(s.id);
    console.log(`   - Deleted session: ${s.id}`);
  }

  console.log('🎉 All TrueForge chat history has been successfully cleared!');
}

clearAllSessions().catch((err) => {
  console.error('❌ Failed to clear TrueForge sessions:', err);
  process.exit(1);
});
