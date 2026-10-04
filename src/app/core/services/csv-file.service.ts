import { Injectable } from '@angular/core';
import { CSV_HEADER_ROW, CSV_HEADERS, LEGACY_CSV_HEADERS } from '../constants/csv-schema';
import { Transaction } from '../models/transaction.model';

@Injectable({ providedIn: 'root' })
export class CsvFileService {
  async readTransactions(file: File): Promise<Transaction[]> {
    const contents = (await file.text()).replace(/^\uFEFF/, '');
    const records = this.parseRecords(contents);
    const header = records.shift() ?? [];
    const current = this.headersMatch(header, CSV_HEADERS);
    const legacy = this.headersMatch(header, LEGACY_CSV_HEADERS);
    if (!current && !legacy) throw new Error('invalid-csv');

    return records
      .filter((record) => !(record.length === 1 && record[0] === ''))
      .map((record) => {
        const expectedLength = legacy ? LEGACY_CSV_HEADERS.length : CSV_HEADERS.length;
        if (record.length !== expectedLength) throw new Error('invalid-csv');
        const values = legacy
          ? [record[0], record[1], record[2], record[3], record[4], record[7], record[8]]
          : record;
        const amount = Number(values[1]);
        if (!Number.isFinite(amount)) throw new Error('invalid-csv');
        return {
          date: values[0],
          amount,
          transactionType: values[2] as Transaction['transactionType'],
          mainCategory: values[3],
          subcategory: values[4],
          paymentMethod: values[5],
          notes: values[6],
        };
      });
  }

  downloadTransactions(transactions: readonly Transaction[]): void {
    const rows = [CSV_HEADER_ROW, ...transactions.map((transaction) => [
      transaction.date,
      transaction.amount,
      transaction.transactionType,
      transaction.mainCategory,
      transaction.subcategory,
      transaction.paymentMethod,
      transaction.notes,
    ].map((value) => this.escapeCsvValue(value)).join(','))];
    const blob = new Blob([`${rows.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'expense-tracker.csv';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private escapeCsvValue(value: string | number): string {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  }

  private headersMatch(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && expected.every((value, index) => actual[index] === value);
  }

  private parseRecords(contents: string): string[][] {
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
