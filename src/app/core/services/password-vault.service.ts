import { Injectable, inject } from '@angular/core';
import {
  PasswordVaultRecord,
  PasswordVaultSettings,
  TransactionDatabaseService,
} from './transaction-database.service';

const PBKDF2_ITERATIONS = 600_000;
const VERIFIER_CONTEXT = new TextEncoder().encode('expense-tracker-password-vault-v1');

@Injectable({ providedIn: 'root' })
export class PasswordVaultService {
  private readonly database = inject(TransactionDatabaseService);

  async isConfigured(): Promise<boolean> {
    return (await this.database.getPasswordVaultSettings()) !== null;
  }

  async setup(managerPassword: string): Promise<void> {
    if (managerPassword.length < 12) throw new Error('weak-manager-password');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const derived = await this.derive(managerPassword, salt);
    await this.database.savePasswordVaultSettings({
      key: 'password-vault', salt: [...salt], verifier: [...await this.verifier(derived)],
    });
  }

  async add(site: string, password: string, managerPassword: string): Promise<PasswordVaultRecord> {
    site = site.trim();
    if (!site || !password) throw new Error('invalid-password-entry');
    const settings = await this.requireSettings();
    const key = await this.keyForPassword(managerPassword, settings);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(site) },
      key,
      new TextEncoder().encode(password),
    );
    return this.database.addPasswordVaultRecord({
      site,
      iv: [...iv],
      ciphertext: [...new Uint8Array(ciphertext)],
      createdAt: Date.now(),
    });
  }

  async reveal(record: PasswordVaultRecord, managerPassword: string): Promise<string> {
    const settings = await this.requireSettings();
    const key = await this.keyForPassword(managerPassword, settings);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: new TextEncoder().encode(record.site) },
      key,
      new Uint8Array(record.ciphertext),
    );
    return new TextDecoder().decode(plaintext);
  }

  async updatePassword(id: number, password: string, managerPassword: string): Promise<PasswordVaultRecord> {
    if (!password) throw new Error('invalid-password-entry');
    const settings = await this.requireSettings();
    const key = await this.keyForPassword(managerPassword, settings);
    const record = (await this.database.listPasswordVaultRecords()).find((item) => item.id === id);
    if (!record) throw new Error('password-entry-not-found');
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(record.site) },
      key,
      new TextEncoder().encode(password),
    );
    const updated = { ...record, iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
    await this.database.updatePasswordVaultRecord(updated);
    return updated;
  }

  async exportEntries(managerPassword: string): Promise<Array<{ site: string; password: string }>> {
    const settings = await this.requireSettings();
    const key = await this.keyForPassword(managerPassword, settings);
    const records = await this.database.listPasswordVaultRecords();
    return Promise.all(records.map(async (record) => {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: new TextEncoder().encode(record.site) },
        key,
        new Uint8Array(record.ciphertext),
      );
      return { site: record.site, password: new TextDecoder().decode(plaintext) };
    }));
  }

  async rotate(oldPassword: string, newPassword: string): Promise<void> {
    if (newPassword.length < 12) throw new Error('weak-manager-password');
    const currentSettings = await this.requireSettings();
    const oldKey = await this.keyForPassword(oldPassword, currentSettings);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const newDerived = await this.derive(newPassword, salt);
    const newKey = await this.importKey(newDerived);
    const records = await this.database.listPasswordVaultRecords();
    const rotated = await Promise.all(records.map(async (record) => {
      const plaintext = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(record.iv), additionalData: new TextEncoder().encode(record.site) },
        oldKey,
        new Uint8Array(record.ciphertext),
      );
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(record.site) },
        newKey,
        plaintext,
      );
      return { ...record, iv: [...iv], ciphertext: [...new Uint8Array(ciphertext)] };
    }));
    const settings: PasswordVaultSettings = {
      key: 'password-vault', salt: [...salt], verifier: [...await this.verifier(newDerived)],
    };
    await this.database.commitPasswordVaultRotation(settings, rotated);
  }

  async list(): Promise<PasswordVaultRecord[]> {
    return this.database.listPasswordVaultRecords();
  }

  async delete(id: number): Promise<void> {
    await this.database.deletePasswordVaultRecord(id);
  }

  private async requireSettings(): Promise<PasswordVaultSettings> {
    const settings = await this.database.getPasswordVaultSettings();
    if (!settings) throw new Error('vault-not-configured');
    return settings;
  }

  private async keyForPassword(password: string, settings: PasswordVaultSettings): Promise<CryptoKey> {
    const derived = await this.derive(password, new Uint8Array(settings.salt));
    const actual = await this.verifier(derived);
    if (!this.bytesMatch(actual, new Uint8Array(settings.verifier))) throw new Error('incorrect-manager-password');
    return this.importKey(derived);
  }

  private async derive(password: string, salt: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    if (!globalThis.crypto?.subtle || !globalThis.crypto?.getRandomValues) throw new Error('web-crypto-unavailable');
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, material, 256);
    return new Uint8Array(bits);
  }

  private async verifier(derived: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
    const input = new Uint8Array(VERIFIER_CONTEXT.length + derived.length);
    input.set(VERIFIER_CONTEXT);
    input.set(derived, VERIFIER_CONTEXT.length);
    return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  }

  private async importKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  private bytesMatch(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;
    let difference = 0;
    for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
    return difference === 0;
  }
}
