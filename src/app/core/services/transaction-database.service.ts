import { Injectable, signal } from '@angular/core';
import { Transaction } from '../models/transaction.model';
import { TransactionRecord } from '../models/transaction-record.model';

const DATABASE_NAME = 'expense-tracker';
const DATABASE_VERSION = 3;
const STORE_NAME = 'transactions';
const SETTINGS_STORE = 'settings';
const PASSWORD_STORE = 'passwords';
const SECURITY_KEY = 'security';
const PBKDF2_ITERATIONS = 600_000;

interface SecuritySettings {
  key: typeof SECURITY_KEY;
  pinSalt: string;
  pinVerifier: string;
  recoveryQuestion: string;
  recoverySalt: string;
  recoveryVerifier: string;
}

export interface PasswordVaultRecord {
  id: number;
  site: string;
  iv: number[];
  ciphertext: number[];
  createdAt: number;
}

export interface PasswordVaultSettings {
  key: 'password-vault';
  salt: number[];
  verifier: number[];
}

@Injectable({ providedIn: 'root' })
export class TransactionDatabaseService {
  readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  private databasePromise: Promise<IDBDatabase> | null = null;

  async initialize(): Promise<void> {
    try {
      await this.openDatabase();
      this.status.set('ready');
    } catch {
      this.status.set('error');
      throw new Error('database-unavailable');
    }
  }

  async getSecuritySettings(): Promise<SecuritySettings | null> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(SETTINGS_STORE, 'readonly').objectStore(SETTINGS_STORE).get(SECURITY_KEY);
      request.onsuccess = () => resolve((request.result as SecuritySettings | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('settings-read-failed'));
    });
  }

  async setupSecurity(pin: string, recoveryQuestion: string, recoveryAnswer: string): Promise<void> {
    const pinSalt = this.newSalt();
    const recoverySalt = this.newSalt();
    const [pinVerifier, recoveryVerifier] = await Promise.all([
      this.deriveVerifier(pin, pinSalt),
      this.deriveVerifier(this.normalizeAnswer(recoveryAnswer), recoverySalt),
    ]);
    await this.saveSecuritySettings({
      key: SECURITY_KEY,
      pinSalt,
      pinVerifier,
      recoveryQuestion: recoveryQuestion.trim(),
      recoverySalt,
      recoveryVerifier,
    });
  }

  async verifyPin(pin: string): Promise<boolean> {
    const settings = await this.getSecuritySettings();
    return settings ? this.matches(pin, settings.pinSalt, settings.pinVerifier) : false;
  }

  async getRecoveryQuestion(): Promise<string | null> {
    return (await this.getSecuritySettings())?.recoveryQuestion ?? null;
  }

  async changePin(currentPin: string, newPin: string): Promise<boolean> {
    const settings = await this.getSecuritySettings();
    if (!settings || !(await this.matches(currentPin, settings.pinSalt, settings.pinVerifier))) return false;
    const pinSalt = this.newSalt();
    const pinVerifier = await this.deriveVerifier(newPin, pinSalt);
    await this.saveSecuritySettings({ ...settings, pinSalt, pinVerifier });
    return true;
  }

  async recoverPin(recoveryAnswer: string, newPin: string): Promise<boolean> {
    const settings = await this.getSecuritySettings();
    if (!settings || !(await this.matches(this.normalizeAnswer(recoveryAnswer), settings.recoverySalt, settings.recoveryVerifier))) return false;
    const pinSalt = this.newSalt();
    const pinVerifier = await this.deriveVerifier(newPin, pinSalt);
    await this.saveSecuritySettings({ ...settings, pinSalt, pinVerifier });
    return true;
  }

  async listTransactions(): Promise<TransactionRecord[]> {
    const database = await this.openDatabase();
    return this.getAllFrom(database);
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

  async update(transaction: TransactionRecord): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(transaction);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('database-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('database-write-failed'));
    });
  }

  async delete(id: number): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('database-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('database-write-failed'));
    });
  }

  async getPasswordVaultSettings(): Promise<PasswordVaultSettings | null> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(SETTINGS_STORE, 'readonly').objectStore(SETTINGS_STORE).get('password-vault');
      request.onsuccess = () => resolve((request.result as PasswordVaultSettings | undefined) ?? null);
      request.onerror = () => reject(request.error ?? new Error('settings-read-failed'));
    });
  }

  async savePasswordVaultSettings(settings: PasswordVaultSettings): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(SETTINGS_STORE, 'readwrite');
      tx.objectStore(SETTINGS_STORE).put(settings);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('settings-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('settings-write-failed'));
    });
  }

  async listPasswordVaultRecords(): Promise<PasswordVaultRecord[]> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(PASSWORD_STORE, 'readonly').objectStore(PASSWORD_STORE).getAll();
      request.onsuccess = () => resolve(request.result as PasswordVaultRecord[]);
      request.onerror = () => reject(request.error ?? new Error('password-read-failed'));
    });
  }

  async addPasswordVaultRecord(record: Omit<PasswordVaultRecord, 'id'>): Promise<PasswordVaultRecord> {
    const database = await this.openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(PASSWORD_STORE, 'readwrite');
      const request = tx.objectStore(PASSWORD_STORE).add(record);
      let id = 0;
      request.onsuccess = () => { id = request.result as number; };
      request.onerror = () => reject(request.error ?? new Error('password-write-failed'));
      tx.onerror = () => reject(tx.error ?? new Error('password-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('password-write-failed'));
      tx.oncomplete = () => resolve({ ...record, id });
    });
  }

  async replacePasswordVaultRecords(records: readonly PasswordVaultRecord[]): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(PASSWORD_STORE, 'readwrite');
      const store = tx.objectStore(PASSWORD_STORE);
      for (const record of records) store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('password-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('password-write-failed'));
    });
  }

  async commitPasswordVaultRotation(settings: PasswordVaultSettings, records: readonly PasswordVaultRecord[]): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction([SETTINGS_STORE, PASSWORD_STORE], 'readwrite');
      tx.objectStore(SETTINGS_STORE).put(settings);
      const store = tx.objectStore(PASSWORD_STORE);
      for (const record of records) store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('password-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('password-write-failed'));
    });
  }

  async deletePasswordVaultRecord(id: number): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(PASSWORD_STORE, 'readwrite');
      tx.objectStore(PASSWORD_STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('password-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('password-write-failed'));
    });
  }

  private async getAllFrom(database: IDBDatabase): Promise<TransactionRecord[]> {
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
      request.onsuccess = () => resolve(request.result as TransactionRecord[]);
      request.onerror = () => reject(request.error ?? new Error('database-read-failed'));
    });
  }

  private async saveSecuritySettings(settings: SecuritySettings): Promise<void> {
    const database = await this.openDatabase();
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction(SETTINGS_STORE, 'readwrite');
      tx.objectStore(SETTINGS_STORE).put(settings);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('settings-write-failed'));
      tx.onabort = () => reject(tx.error ?? new Error('settings-write-failed'));
    });
  }

  private async matches(value: string, salt: string, expected: string): Promise<boolean> {
    return this.deriveVerifier(value, salt).then((actual) => actual === expected);
  }

  private async deriveVerifier(value: string, salt: string): Promise<string> {
    if (!globalThis.crypto?.subtle) throw new Error('secure-crypto-unavailable');
    const material = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(value), 'PBKDF2', false, ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits({
      name: 'PBKDF2',
      salt: this.fromHex(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    }, material, 256);
    return this.toHex(new Uint8Array(bits));
  }

  private newSalt(): string {
    if (!globalThis.crypto?.getRandomValues) throw new Error('secure-crypto-unavailable');
    return this.toHex(crypto.getRandomValues(new Uint8Array(16)));
  }

  private normalizeAnswer(answer: string): string {
    return answer.trim().toLocaleLowerCase();
  }

  private toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  private fromHex(value: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(value.length / 2);
    for (let index = 0; index < value.length; index += 2) {
      bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
    }
    return bytes;
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
          if (!database.objectStoreNames.contains(SETTINGS_STORE)) {
            database.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
          }
          if (!database.objectStoreNames.contains(PASSWORD_STORE)) {
            database.createObjectStore(PASSWORD_STORE, { keyPath: 'id', autoIncrement: true });
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
