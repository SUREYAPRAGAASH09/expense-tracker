import { TestBed } from '@angular/core/testing';
import { PasswordVaultService } from './password-vault.service';
import { PasswordVaultRecord, PasswordVaultSettings, TransactionDatabaseService } from './transaction-database.service';

const MANAGER_PASSWORD = 'correct horse battery staple';
const ROTATED_PASSWORD = 'another strong passphrase';

describe('PasswordVaultService', () => {
  let service: PasswordVaultService;
  let settings: PasswordVaultSettings | null;
  let records: PasswordVaultRecord[];
  let failRotationCommit: boolean;
  let nextId: number;

  beforeEach(() => {
    settings = null;
    records = [];
    failRotationCommit = false;
    nextId = 1;
    const database = {
      getPasswordVaultSettings: async () => settings,
      savePasswordVaultSettings: async (next: PasswordVaultSettings) => { settings = structuredClone(next); },
      listPasswordVaultRecords: async () => structuredClone(records),
      addPasswordVaultRecord: async (record: Omit<PasswordVaultRecord, 'id'>) => {
        const saved = { ...structuredClone(record), id: nextId++ };
        records.push(saved);
        return structuredClone(saved);
      },
      deletePasswordVaultRecord: async (id: number) => { records = records.filter((record) => record.id !== id); },
      commitPasswordVaultRotation: async (nextSettings: PasswordVaultSettings, nextRecords: readonly PasswordVaultRecord[]) => {
        if (failRotationCommit) throw new Error('simulated-commit-failure');
        settings = structuredClone(nextSettings);
        records = structuredClone([...nextRecords]);
      },
    };

    TestBed.configureTestingModule({ providers: [
      PasswordVaultService,
      { provide: TransactionDatabaseService, useValue: database },
    ] });
    service = TestBed.inject(PasswordVaultService);
  });

  it('creates a vault, encrypts entries at rest, and decrypts Unicode credentials after verification', async () => {
    await service.setup(MANAGER_PASSWORD);
    const saved = await service.add('例え.テスト', '🔐 pässword-秘密', MANAGER_PASSWORD);

    expect(saved.site).toBe('例え.テスト');
    expect(saved.iv).toHaveLength(12);
    expect(new TextDecoder().decode(new Uint8Array(saved.ciphertext))).not.toContain('pässword');
    expect(await service.reveal(saved, MANAGER_PASSWORD)).toBe('🔐 pässword-秘密');
  });

  it('rejects a weak manager password and invalid empty entries', async () => {
    await expect(service.setup('short')).rejects.toThrow('weak-manager-password');
    await service.setup(MANAGER_PASSWORD);
    await expect(service.add('   ', 'secret', MANAGER_PASSWORD)).rejects.toThrow('invalid-password-entry');
    await expect(service.add('example.com', '', MANAGER_PASSWORD)).rejects.toThrow('invalid-password-entry');
  });

  it('rejects an incorrect manager password without returning plaintext', async () => {
    await service.setup(MANAGER_PASSWORD);
    const saved = await service.add('example.com', 'do-not-disclose', MANAGER_PASSWORD);
    await expect(service.reveal(saved, 'incorrect manager password')).rejects.toThrow('incorrect-manager-password');
  });

  it('authenticates the site name as additional data and rejects tampered ciphertext', async () => {
    await service.setup(MANAGER_PASSWORD);
    const saved = await service.add('example.com', 'site-secret', MANAGER_PASSWORD);

    await expect(service.reveal({ ...saved, site: 'attacker.example' }, MANAGER_PASSWORD)).rejects.toBeTruthy();
    const changedCiphertext = [...saved.ciphertext];
    changedCiphertext[0] ^= 1;
    await expect(service.reveal({ ...saved, ciphertext: changedCiphertext }, MANAGER_PASSWORD)).rejects.toBeTruthy();
  });

  it('uses a distinct random nonce for each encryption, including duplicate sites', async () => {
    await service.setup(MANAGER_PASSWORD);
    const first = await service.add('example.com', 'first-secret', MANAGER_PASSWORD);
    const second = await service.add('example.com', 'second-secret', MANAGER_PASSWORD);

    expect(first.iv).toHaveLength(12);
    expect(second.iv).toHaveLength(12);
    expect(second.iv).not.toEqual(first.iv);
    await expect(service.reveal(first, MANAGER_PASSWORD)).resolves.toBe('first-secret');
    await expect(service.reveal(second, MANAGER_PASSWORD)).resolves.toBe('second-secret');
  });

  it('rotates the manager key and re-encrypts all records atomically', async () => {
    await service.setup(MANAGER_PASSWORD);
    const first = await service.add('one.example', 'secret-one', MANAGER_PASSWORD);
    const second = await service.add('two.example', 'secret-two', MANAGER_PASSWORD);
    const oldSalt = [...settings!.salt];

    await service.rotate(MANAGER_PASSWORD, ROTATED_PASSWORD);
    const rotated = await service.list();

    expect(settings!.salt).not.toEqual(oldSalt);
    expect(rotated).toHaveLength(2);
    expect(rotated[0].ciphertext).not.toEqual(first.ciphertext);
    await expect(service.reveal(rotated[0], MANAGER_PASSWORD)).rejects.toThrow('incorrect-manager-password');
    await expect(service.reveal(rotated[0], ROTATED_PASSWORD)).resolves.toBe('secret-one');
    await expect(service.reveal(rotated[1], ROTATED_PASSWORD)).resolves.toBe('secret-two');
    await expect(service.rotate(ROTATED_PASSWORD, 'tiny')).rejects.toThrow('weak-manager-password');
  });

  it('leaves saved data and settings unchanged when rotation cannot commit', async () => {
    await service.setup(MANAGER_PASSWORD);
    const saved = await service.add('example.com', 'preserve-me', MANAGER_PASSWORD);
    const oldSettings = structuredClone(settings);
    failRotationCommit = true;

    await expect(service.rotate(MANAGER_PASSWORD, ROTATED_PASSWORD)).rejects.toThrow('simulated-commit-failure');
    expect(settings).toEqual(oldSettings);
    expect(records).toEqual([saved]);
    await expect(service.reveal(saved, MANAGER_PASSWORD)).resolves.toBe('preserve-me');
  });

  it('fails rotation if any existing record has been tampered with', async () => {
    await service.setup(MANAGER_PASSWORD);
    const saved = await service.add('example.com', 'preserve-me', MANAGER_PASSWORD);
    const oldSettings = structuredClone(settings);
    records[0].ciphertext[0] ^= 1;
    const tamperedRecords = structuredClone(records);

    await expect(service.rotate(MANAGER_PASSWORD, ROTATED_PASSWORD)).rejects.toBeTruthy();
    expect(settings).toEqual(oldSettings);
    expect(records).toEqual(tamperedRecords);
    expect(records[0].id).toBe(saved.id);
  });

  it('supports rotation when the vault has no entries', async () => {
    await service.setup(MANAGER_PASSWORD);
    await service.rotate(MANAGER_PASSWORD, ROTATED_PASSWORD);
    expect(await service.list()).toEqual([]);
    await expect(service.rotate(MANAGER_PASSWORD, 'another new strong passphrase')).rejects.toThrow('incorrect-manager-password');
  });
});
