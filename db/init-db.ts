import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbDir = path.resolve(__dirname, '../data');
const dbPath = path.resolve(dbDir, 'erp.db');
const schemaPath = path.resolve(__dirname, 'schema.sql');
const seedPath = path.resolve(__dirname, 'seed.sql');

async function getDatabase(targetPath: string) {
  try {
    const { default: Database } = await import('better-sqlite3');
    return new Database(targetPath);
  } catch {
    // Fallback to Node 22+ built-in node:sqlite
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(targetPath);
    return {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => ({
        all: (...params: any[]) => db.prepare(sql).all(...params),
        get: (...params: any[]) => db.prepare(sql).get(...params),
        run: (...params: any[]) => db.prepare(sql).run(...params),
      }),
      close: () => db.close(),
    };
  }
}

export async function initDatabase() {
  console.log('🚀 Initializing ERP Database at:', dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const seedSql = fs.readFileSync(seedPath, 'utf8');

  const db = await getDatabase(dbPath);

  try {
    console.log('📦 Applying schema...');
    db.exec(schemaSql);

    console.log('🌱 Applying intentional seed data...');
    db.exec(seedSql);

    console.log('✅ ERP Database initialized and seeded successfully!');
  } finally {
    db.close();
  }
}

// Run directly when invoked from CLI
if (process.argv[1] === __filename) {
  initDatabase().catch((err) => {
    console.error('❌ Failed to initialize database:', err);
    process.exit(1);
  });
}
