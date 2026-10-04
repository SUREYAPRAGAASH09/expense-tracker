import { Injectable, signal } from '@angular/core';
import { Transaction } from '../models/transaction.model';
import { TransactionRecord } from '../models/transaction-record.model';

const DATABASE_NAME = 'expense-tracker';
const DATABASE_VERSION = 1;
const STORE_NAME = 'transactions';

@Injectable({ providedIn: 'root' })
export class TransactionDatabaseService {
  readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  private databasePromise: Promise<IDBDatabase> | null = null;

  async initialize(): Promise<TransactionRecord[]> {
    try {
      const database = await this.openDatabase();
      const records = await this.getAllFrom(database);
      this.status.set('ready');
      return records;
    } catch {
      this.status.set('error');
      throw new Error('database-unavailable');
    }
  }

  async add(transaction: Transaction): Promise<TransactionRecord> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      const createdAt = Date.now();
      const request = tx.objectStore(STORE_NAME).add({ ...transaction, createdAt });
      let id: number;
      request.onsuccess = () => { id = request.result as number; };
      request.onerror = () => reject(request.error ?? new Error('database-write-failed'));
      tx.onerror = () => reject(tx.error ?? new Error('database-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('database-write-failed'));
      tx.oncomplete = () => resolve({ ...transaction, createdAt, id });
    });
  }

  async addMany(transactions: readonly Transaction[]): Promise<number> {
    if (!transactions.length) return 0;
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const transaction of transactions) store.add({ ...transaction, createdAt: Date.now() });
      tx.oncomplete = () => resolve(transactions.length);
      tx.onerror = () => reject(tx.error ?? new Error('database-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('database-write-failed'));
    });
  }

  private async getAllFrom(database: IDBDatabase): Promise<TransactionRecord[]> {
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as TransactionRecord[]);
      request.onerror = () => reject(request.error ?? new Error('database-read-failed'));
    });
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('database-unavailable'));
    if (!this.databasePromise) {
      const opening = new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains(STORE_NAME)) {
            database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
          }
        };
        request.onsuccess = () => {
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error ?? new Error('database-unavailable'));
        request.onblocked = () => reject(new Error('database-blocked'));
      });
      this.databasePromise = opening.catch((error: unknown) => {
        this.databasePromise = null;
        throw error;
      });
    }
    return this.databasePromise!;
  }
}
