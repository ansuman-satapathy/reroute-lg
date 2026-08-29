import 'dotenv/config';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const TRUEFORGE_BASE_URL =
  process.env.TRUEFORGE_URL ||
  process.env.TRUEFORGE_BASE_URL ||
  'http://localhost:8790';

async function clearAllSessions() {
  console.log(`🧹 Connecting to TrueForge at: ${TRUEFORGE_BASE_URL}...`);
  const client = new TrueForge({ baseUrl: TRUEFORGE_BASE_URL });

  let totalDeleted = 0;
  while (true) {
    const res = await client.sessions.list();
    const sessions = res.data || [];
    if (sessions.length === 0) break;

    console.log(`🗑️ Deleting batch of ${sessions.length} chat session(s)...`);
    for (const s of sessions) {
      await client.sessions.delete(s.id);
      totalDeleted++;
    }
  }

  if (totalDeleted === 0) {
    console.log('✨ No chat sessions found. Workspace is already completely clean!');
  } else {
    console.log(`🎉 All ${totalDeleted} TrueForge chat session(s) successfully deleted!`);
  }
}

clearAllSessions().catch((err) => {
  console.error('❌ Failed to clear TrueForge sessions:', err);
  process.exit(1);
});
