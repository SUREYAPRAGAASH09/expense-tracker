import { Injectable, signal } from '@angular/core';
import { CSV_HEADER_ROW, CSV_HEADERS, LEGACY_CSV_HEADERS } from '../constants/csv-schema';
import { Transaction } from '../models/transaction.model';

type FilePermissionMode = 'read' | 'readwrite';
type FilePermissionState = 'granted' | 'denied' | 'prompt';

interface WritableFile {
  write(data: string): Promise<void>;
  close(): Promise<void>;
}

interface CsvFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<WritableFile>;
  queryPermission(options: { mode: FilePermissionMode }): Promise<FilePermissionState>;
  requestPermission(options: { mode: FilePermissionMode }): Promise<FilePermissionState>;
}

interface FilePickerWindow extends Window {
  showOpenFilePicker?: (options?: { multiple?: false }) => Promise<CsvFileHandle[]>;

  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<CsvFileHandle>;
}

export type CsvConnectionStatus = 'unsupported' | 'disconnected' | 'connected' | 'download';

@Injectable({ providedIn: 'root' })
export class CsvFileService {
  private readonly pickerWindow = window as FilePickerWindow;

  private fileHandle: CsvFileHandle | null = null;
  private usingFallbackFile = false;

  // Used by browsers that do not support the File System Access API.
  private fallbackFileName = 'expense-tracker.csv';
  private fallbackContents = `${CSV_HEADER_ROW}\r\n`;

  readonly status = signal<CsvConnectionStatus>(
    this.supportsDirectFileAccess ? 'disconnected' : 'unsupported'
  );

  readonly fileName = signal<string | null>(null);

  get supportsDirectFileAccess(): boolean {
    return (
      typeof this.pickerWindow.showOpenFilePicker === 'function' &&
      typeof this.pickerWindow.showSaveFilePicker === 'function'
    );
  }

  async selectCsvFile(): Promise<void> {
    const picker = this.pickerWindow.showOpenFilePicker;

    if (!picker) {
      throw new Error('unsupported');
    }

    // Android file providers sometimes label CSV files with a MIME type other
    // than text/csv. Let the picker show all files and validate the contents.
    const [handle] = await picker.call(this.pickerWindow, { multiple: false });

    let permission: FilePermissionState;

    try {
      permission = await handle.requestPermission({
        mode: 'readwrite',
      });
    } catch {
      throw new Error('permission-denied');
    }

    if (permission !== 'granted') {
      throw new Error('permission-denied');
    }

    try {
      const file = await handle.getFile();

      this.normalizeCsvContents(await file.text());
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'invalid-csv'
      ) {
        throw error;
      }

      if (
        error instanceof DOMException &&
        error.name === 'NotAllowedError'
      ) {
        throw new Error('permission-denied');
      }

      throw new Error('open-file-failure');
    }

    this.fileHandle = handle;
    this.usingFallbackFile = false;
    this.fileName.set(handle.name);
    this.status.set('connected');
  }

  /**
   * Fallback file selection for browsers that do not support
   * the File System Access API, such as iPhone browsers.
   *
   * The selected file is read into memory. Changes are later
   * downloaded as a new CSV file.
   */
  async selectFallbackFile(file: File): Promise<void> {
    try {
      const contents = await file.text();

      this.fallbackContents = this.normalizeCsvContents(contents);

      this.fallbackFileName = file.name;
      this.usingFallbackFile = true;

      this.fileName.set(file.name);
      this.status.set('download');
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'invalid-csv'
      ) {
        throw error;
      }

      throw new Error('open-file-failure');
    }
  }

  async createCsvFile(): Promise<void> {
    const picker = this.pickerWindow.showSaveFilePicker;

    if (!picker) {
      throw new Error('unsupported');
    }

    const handle = await picker.call(this.pickerWindow, {
      suggestedName: 'expense-tracker.csv',
      types: [
        {
          description: 'CSV files',
          accept: {
            'text/csv': ['.csv'],
          },
        },
      ],
    });

    const existingFile = await handle.getFile();

    if (existingFile.size > 0) {
      this.normalizeCsvContents(await existingFile.text());

      this.fileHandle = handle;
      this.fileName.set(handle.name);
      this.status.set('connected');

      return;
    }

    let writable: WritableFile;

    try {
      writable = await handle.createWritable();
    } catch (error) {
      if (
        error instanceof DOMException &&
        error.name === 'NotAllowedError'
      ) {
        throw new Error('permission-denied');
      }

      throw new Error('create-file-failure');
    }

    try {
      await writable.write(`${CSV_HEADER_ROW}\r\n`);
      await writable.close();
    } catch (error) {
      await writable.close().catch(() => undefined);

      if (
        error instanceof DOMException &&
        error.name === 'NotAllowedError'
      ) {
        throw new Error('permission-denied');
      }

      throw new Error('create-file-failure');
    }

    this.fileHandle = handle;
    this.usingFallbackFile = false;
    this.fileName.set(handle.name);
    this.status.set('connected');
  }

  /**
   * Generates a blank CSV template and downloads it.
   */
  downloadCsvTemplate(): void {
    this.downloadContents(
      `${CSV_HEADER_ROW}\r\n`,
      'expense-tracker.csv'
    );
  }

  async appendTransaction(
    transaction: Transaction
  ): Promise<'saved' | 'downloaded'> {
    const values = [
      transaction.date,
      transaction.amount,
      transaction.transactionType,
      transaction.mainCategory,
      transaction.subcategory,
      transaction.paymentMethod,
      transaction.notes,
    ];

    const row = values
      .map((value) => this.escapeCsvValue(value))
      .join(',');

    /*
     * Fallback mode:
     *
     * Used on browsers such as iPhone browsers where the
     * File System Access API is unavailable.
     *
     * The CSV is maintained in memory and the updated
     * contents are downloaded after every transaction.
     */
    if (this.usingFallbackFile || !this.supportsDirectFileAccess) {
      const lineBreak =
        this.fallbackContents.length > 0 &&
        !/[\r\n]$/.test(this.fallbackContents)
          ? '\r\n'
          : '';

      this.fallbackContents += `${lineBreak}${row}\r\n`;

      this.downloadContents(
        this.fallbackContents,
        this.fallbackFileName
      );

      return 'downloaded';
    }

    /*
     * Direct file mode:
     *
     * Existing desktop / Android implementation.
     */
    const handle = this.fileHandle;

    if (!handle) {
      throw new Error('no-file');
    }

    try {
      let permission = await handle.queryPermission({
        mode: 'readwrite',
      });

      if (permission !== 'granted') {
        permission = await handle.requestPermission({
          mode: 'readwrite',
        });
      }

      if (permission !== 'granted') {
        this.disconnect();
        throw new Error('permission-denied');
      }

      const file = await handle.getFile();
      const current = await file.text();

      const normalized = this.normalizeCsvContents(current);

      const writable = await handle.createWritable();

      try {
        const base = normalized === current ? current : normalized;
        const separator =
          base.length > 0 && !/[\r\n]$/.test(base)
            ? '\r\n'
            : '';
        await writable.write(`${base}${separator}${row}\r\n`);

        await writable.close();
      } catch (error) {
        await writable.close().catch(() => undefined);

        if (
          error instanceof DOMException &&
          error.name === 'NotAllowedError'
        ) {
          this.disconnect();
          throw new Error('permission-denied');
        }

        throw new Error('write-failure');
      }

      return 'saved';
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'permission-denied',
          'invalid-csv',
          'write-failure',
          'no-file',
        ].includes(error.message)
      ) {
        throw error;
      }

      if (
        error instanceof DOMException &&
        error.name === 'NotFoundError'
      ) {
        throw new Error('file-not-found');
      }

      if (
        error instanceof DOMException &&
        error.name === 'NotAllowedError'
      ) {
        this.disconnect();
        throw new Error('permission-denied');
      }

      throw new Error('write-failure');
    }
  }

  private escapeCsvValue(value: string | number): string {
    const text = String(value);

    return /[",\r\n]/.test(text)
      ? `"${text.replace(/"/g, '""')}"`
      : text;
  }

  private downloadContents(
    contents: string,
    fileName = 'expense-tracker.csv'
  ): void {
    const blob = new Blob([contents], {
      type: 'text/csv;charset=utf-8',
    });

    const url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;

    anchor.click();

    window.setTimeout(
      () => URL.revokeObjectURL(url),
      0
    );
  }

  validateCsvHeader(contents: string): void {
    this.normalizeCsvContents(contents);
  }

  disconnect(): void {
    this.fileHandle = null;
    this.usingFallbackFile = false;
    this.fallbackContents = `${CSV_HEADER_ROW}\r\n`;
    this.fallbackFileName = 'expense-tracker.csv';

    this.fileName.set(null);

    this.status.set(
      this.supportsDirectFileAccess
        ? 'disconnected'
        : 'unsupported'
    );
  }

  private normalizeCsvContents(contents: string): string {
    const clean = contents.replace(/^\uFEFF/, '');
    const records = this.parseCsvRecords(clean);
    const header = records[0] ?? [];
    const isCurrent = this.headersMatch(header, CSV_HEADERS);
    const isLegacy = this.headersMatch(header, LEGACY_CSV_HEADERS);
    if (!isCurrent && !isLegacy) throw new Error('invalid-csv');
    if (isCurrent) return clean;

    const retainedColumns = [0, 1, 2, 3, 7, 8];
    const normalized = [
      [...CSV_HEADERS],
      ...records.slice(1).filter((record) => !(record.length === 1 && record[0] === '')).map((record) => {
        if (record.length !== LEGACY_CSV_HEADERS.length) throw new Error('invalid-csv');
        return retainedColumns.map((column) => record[column]);
      }),
    ];
    return normalized
      .map((record) => record.map((value) => this.escapeCsvValue(value)).join(','))
      .join('\r\n') + '\r\n';
  }

  private headersMatch(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && expected.every((value, index) => actual[index] === value);
  }

  private parseCsvRecords(contents: string): string[][] {
    const records: string[][] = [];
    let record: string[] = [];
    let value = '';
    let quoted = false;

    for (let index = 0; index < contents.length; index += 1) {
      const char = contents[index];
      if (char === '"' && quoted && contents[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        record.push(value);
        value = '';
      } else if ((char === '\r' || char === '\n') && !quoted) {
        record.push(value);
        if (!(record.length === 1 && record[0] === '')) records.push(record);
        record = [];
        value = '';
        if (char === '\r' && contents[index + 1] === '\n') index += 1;
      } else {
        value += char;
      }
    }

    if (quoted) throw new Error('invalid-csv');
    if (value.length > 0 || record.length > 0) {
      record.push(value);
      records.push(record);
    }
    return records;
  }
}
