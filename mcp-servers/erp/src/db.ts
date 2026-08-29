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
  // Default to repo root data/erp.db
  return path.resolve(__dirname, '../../../data/erp.db');
}

export interface DatabaseConnection {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): any;
  };
  close(): void;
}

let dbInstance: DatabaseConnection | null = null;

export async function getErpDb(): Promise<DatabaseConnection> {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = resolveDatabasePath();

  if (!fs.existsSync(dbPath)) {
    throw new Error(
      `ERP database file not found at ${dbPath}. Please run 'npm run db:init' from the project root first.`
    );
  }

  // 1. Try Node 22+ built-in node:sqlite
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    dbInstance = {
      exec: (sql: string) => db.exec(sql),
      prepare: (sql: string) => ({
        all: (...params: any[]) => db.prepare(sql).all(...params),
        get: (...params: any[]) => db.prepare(sql).get(...params),
        run: (...params: any[]) => db.prepare(sql).run(...params),
      }),
      close: () => {
        db.close();
        dbInstance = null;
      },
    };
    return dbInstance;
  } catch {
    // 2. Fallback to better-sqlite3
    try {
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(dbPath);
      dbInstance = {
        exec: (sql: string) => db.exec(sql),
        prepare: (sql: string) => ({
          all: (...params: any[]) => db.prepare(sql).all(...params),
          get: (...params: any[]) => db.prepare(sql).get(...params),
          run: (...params: any[]) => db.prepare(sql).run(...params),
        }),
        close: () => {
          db.close();
          dbInstance = null;
        },
      };
      return dbInstance;
    } catch {
      throw new Error(
        'No compatible SQLite driver found. Please use Node.js >= 22.13.0 or install better-sqlite3.'
      );
    }
  }
}
