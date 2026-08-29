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

/**
 * Strict Read-Only Database Connection Interface
 * Enforces process-level read-only safety for read tools (omits exec/run mutation APIs)
 */
export interface ReadOnlyDatabaseConnection {
  prepare(sql: string): {
    all(...params: any[]): any[];
    get(...params: any[]): any;
  };
  close(): void;
}

/**
 * Strictly Scoped Write Database Connection Interface
 * Enforces authorization boundary: write statements MUST only target purchase_orders
 */
export interface WriteDatabaseConnection {
  prepare(sql: string): {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): { lastInsertRowid: number | bigint; changes: number };
  };
  close(): void;
}

type DriverType = 'node:sqlite' | 'better-sqlite3';

interface ResolvedDriver {
  type: DriverType;
  ctor: any;
}

let cachedDriver: ResolvedDriver | null = null;

/**
 * Separates driver module loading from database construction.
 * Ensures open/constructor errors (e.g. permissions, corruption) are preserved rather than masked.
 */
async function getDriver(): Promise<ResolvedDriver> {
  if (cachedDriver) {
    return cachedDriver;
  }

  // 1. Try Node 22+ built-in node:sqlite module
  try {
    const { DatabaseSync } = await import('node:sqlite');
    cachedDriver = { type: 'node:sqlite', ctor: DatabaseSync };
    return cachedDriver;
  } catch {
    // node:sqlite module unavailable
  }

  // 2. Fallback to better-sqlite3 module
  try {
    const { default: Database } = await import('better-sqlite3');
    cachedDriver = { type: 'better-sqlite3', ctor: Database };
    return cachedDriver;
  } catch {
    // better-sqlite3 module unavailable
  }

  throw new Error(
    'No compatible SQLite driver found. Please use Node.js >= 22.13.0 (built-in node:sqlite) or install better-sqlite3.'
  );
}

let readDbInstance: ReadOnlyDatabaseConnection | null = null;
let readDbInitPromise: Promise<ReadOnlyDatabaseConnection> | null = null;

/**
 * Thread-safe singleton providing a read-only SQLite database connection.
 * Deduplicates concurrent initializations to prevent connection leaks.
 */
export async function getErpDb(): Promise<ReadOnlyDatabaseConnection> {
  if (readDbInstance) {
    return readDbInstance;
  }

  if (readDbInitPromise) {
    return readDbInitPromise;
  }

  readDbInitPromise = (async () => {
    try {
      const dbPath = resolveDatabasePath();

      if (!fs.existsSync(dbPath)) {
        throw new Error(
          `ERP database file not found at ${dbPath}. Please run 'npm run db:init' from the project root first.`
        );
      }

      const driver = await getDriver();
      let rawDb: any;

      // Open strictly in read-only mode
      if (driver.type === 'node:sqlite') {
        rawDb = new driver.ctor(dbPath, { readOnly: true });
      } else {
        rawDb = new driver.ctor(dbPath, { readonly: true });
      }

      readDbInstance = {
        prepare: (sql: string) => ({
          all: (...params: any[]) => rawDb.prepare(sql).all(...params),
          get: (...params: any[]) => rawDb.prepare(sql).get(...params),
        }),
        close: () => {
          rawDb.close();
          readDbInstance = null;
          readDbInitPromise = null;
        },
      };

      return readDbInstance;
    } finally {
      readDbInitPromise = null;
    }
  })();

  return readDbInitPromise;
}

let writeDbInstance: WriteDatabaseConnection | null = null;
let writeDbInitPromise: Promise<WriteDatabaseConnection> | null = null;

/**
 * Validates that write queries only target the purchase_orders ledger.
 * Throws security exception if any query attempts to modify suppliers or inventory.
 */
function assertPermittedWriteSql(sql: string): void {
  const normalized = sql.trim().toUpperCase();
  const isMutation =
    normalized.startsWith('INSERT') ||
    normalized.startsWith('UPDATE') ||
    normalized.startsWith('DELETE');

  if (isMutation) {
    const isPurchaseOrderTarget =
      normalized.includes('PURCHASE_ORDERS') &&
      !normalized.includes('SUPPLIERS') &&
      !normalized.includes('INVENTORY') &&
      !normalized.includes('SUPPLIER_CATALOG');

    if (!isPurchaseOrderTarget) {
      throw new Error(
        `Security Policy Violation: Mutations are strictly limited to 'purchase_orders'. Forbidden query: ${sql}`
      );
    }
  }
}

/**
 * Thread-safe singleton providing a scoped write SQLite database connection.
 * Dedicated to purchase_orders ledger mutations with strict table allowlisting.
 */
export async function getErpWriteDb(): Promise<WriteDatabaseConnection> {
  if (writeDbInstance) {
    return writeDbInstance;
  }

  if (writeDbInitPromise) {
    return writeDbInitPromise;
  }

  writeDbInitPromise = (async () => {
    try {
      const dbPath = resolveDatabasePath();

      if (!fs.existsSync(dbPath)) {
        throw new Error(
          `ERP database file not found at ${dbPath}. Please run 'npm run db:init' from the project root first.`
        );
      }

      const driver = await getDriver();
      let rawDb: any;

      // Open in read-write mode
      if (driver.type === 'node:sqlite') {
        rawDb = new driver.ctor(dbPath, { readOnly: false });
      } else {
        rawDb = new driver.ctor(dbPath, { readonly: false });
      }

      writeDbInstance = {
        prepare: (sql: string) => {
          assertPermittedWriteSql(sql);
          const stmt = rawDb.prepare(sql);
          return {
            all: (...params: any[]) => stmt.all(...params),
            get: (...params: any[]) => stmt.get(...params),
            run: (...params: any[]) => stmt.run(...params),
          };
        },
        close: () => {
          rawDb.close();
          writeDbInstance = null;
          writeDbInitPromise = null;
        },
      };

      return writeDbInstance;
    } finally {
      writeDbInitPromise = null;
    }
  })();

  return writeDbInitPromise;
}

export async function closeErpDbs(): Promise<void> {
  if (writeDbInstance) {
    writeDbInstance.close();
    writeDbInstance = null;
  }
  if (readDbInstance) {
    readDbInstance.close();
    readDbInstance = null;
  }
}
