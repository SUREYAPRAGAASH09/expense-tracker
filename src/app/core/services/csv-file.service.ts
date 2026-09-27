import { Injectable, signal } from '@angular/core';
import { CSV_HEADER_ROW, CSV_HEADERS } from '../constants/csv-schema';
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
  showOpenFilePicker?: (options: {
    multiple: false;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<CsvFileHandle[]>;

  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<CsvFileHandle>;
}

export type CsvConnectionStatus = 'unsupported' | 'disconnected' | 'connected';

@Injectable({ providedIn: 'root' })
export class CsvFileService {
  private readonly pickerWindow = window as FilePickerWindow;

  private fileHandle: CsvFileHandle | null = null;

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

    const [handle] = await picker.call(this.pickerWindow, {
      multiple: false,
      types: [
        {
          description: 'CSV files',
          accept: {
            'text/csv': ['.csv'],
          },
        },
      ],
    });

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

      this.validateCsvHeader(await file.text());
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

      this.validateCsvHeader(contents);

      this.fallbackContents = contents;
      this.fallbackFileName = file.name;

      this.fileName.set(file.name);
      this.status.set('connected');
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
      this.validateCsvHeader(await existingFile.text());

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
    if (!this.supportsDirectFileAccess) {
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

      this.validateCsvHeader(current);

      const lineBreak =
        current.length > 0 && !/[\r\n]$/.test(current)
          ? '\r\n'
          : '';

      const writable = await handle.createWritable();

      try {
        await writable.write(
          `${current}${lineBreak}${row}\r\n`
        );

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
    const firstLine =
      contents
        .replace(/^\uFEFF/, '')
        .split(/\r\n|\n|\r/, 1)[0] ?? '';

    const actual = this.parseCsvRow(firstLine);

    const valid =
      actual.length === CSV_HEADERS.length &&
      CSV_HEADERS.every(
        (header, index) => actual[index] === header
      );

    if (!valid) {
      throw new Error('invalid-csv');
    }
  }

  disconnect(): void {
    this.fileHandle = null;

    this.fileName.set(null);

    this.status.set(
      this.supportsDirectFileAccess
        ? 'disconnected'
        : 'unsupported'
    );
  }

  private parseCsvRow(row: string): string[] {
    const cells: string[] = [];

    let value = '';
    let quoted = false;

    for (
      let index = 0;
      index < row.length;
      index += 1
    ) {
      const char = row[index];

      if (
        char === '"' &&
        quoted &&
        row[index + 1] === '"'
      ) {
        value += '"';
        index += 1;
      } else if (char === '"') {
        quoted = !quoted;
      } else if (char === ',' && !quoted) {
        cells.push(value);
        value = '';
      } else {
        value += char;
      }
    }

    if (quoted) {
      throw new Error('invalid-csv');
    }

    cells.push(value);

    return cells;
  }
}