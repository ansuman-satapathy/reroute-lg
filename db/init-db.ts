import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function resolveDatabasePath(): string {
  if (process.env.DATABASE_PATH) {
    return path.resolve(process.cwd(), process.env.DATABASE_PATH);
  }
  return path.resolve(__dirname, '../data/erp.db');
}

const schemaPath = path.resolve(__dirname, 'schema.sql');
const seedPath = path.resolve(__dirname, 'seed.sql');

export interface DatabaseConnection {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): any;
  };
  close(): void;
}

export async function getDatabase(targetPath: string): Promise<DatabaseConnection> {
  // 1. Try Node 22+ built-in node:sqlite first
  try {
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
  } catch {
    // 2. Fallback to better-sqlite3
    try {
      const { default: Database } = await import('better-sqlite3');
      return new Database(targetPath);
    } catch (driverErr) {
      throw new Error(
        'No compatible SQLite driver found. Please use Node.js >= 22.13.0 (for built-in node:sqlite) or install better-sqlite3.'
      );
    }
  }
}

export async function initDatabase() {
  const dbPath = resolveDatabasePath();
  const dbDir = path.dirname(dbPath);

  console.log('🚀 Initializing ERP Database at:', dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const seedSql = fs.readFileSync(seedPath, 'utf8');

  const db = await getDatabase(dbPath);

  try {
    console.log('📦 Rebuilding schema tables in-place...');
    db.exec(`
      PRAGMA foreign_keys = OFF;
      DROP TABLE IF EXISTS purchase_orders;
      DROP TABLE IF EXISTS supplier_catalog;
      DROP TABLE IF EXISTS inventory;
      DROP TABLE IF EXISTS suppliers;
      PRAGMA foreign_keys = ON;
    `);
    db.exec(schemaSql);

    console.log('🌱 Applying intentional seed data in an atomic transaction...');
    db.exec('BEGIN TRANSACTION;');
    try {
      db.exec(seedSql);
      db.exec('COMMIT;');
    } catch (seedError) {
      console.error('❌ Seeding failed! Rolling back transaction...');
      try {
        db.exec('ROLLBACK;');
      } catch (rollbackError) {
        console.error('Failed to rollback transaction:', rollbackError);
      }
      throw seedError;
    }

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
