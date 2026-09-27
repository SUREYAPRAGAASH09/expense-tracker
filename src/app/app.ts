import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { CsvFileService } from './core/services/csv-file.service';
import { CATEGORY_OPTIONS, PAYMENT_METHODS } from './core/constants/transaction-options';
import { TRANSACTION_TYPES, Transaction, TransactionType } from './core/models/transaction.model';

@Component({
  imports: [ReactiveFormsModule],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly csv = inject(CsvFileService);
  private readonly formBuilder = inject(FormBuilder);
  protected readonly transactionTypes = TRANSACTION_TYPES;
  protected readonly paymentMethods = PAYMENT_METHODS;
  protected readonly message = signal('');
  protected readonly messageType = signal<'success' | 'error' | ''>('');
  protected readonly formMessage = signal('');
  protected readonly formMessageType = signal<'success' | 'error' | ''>('');
  protected readonly saving = signal(false);
  protected readonly form = this.formBuilder.group({
    date: [this.today(), Validators.required],
    amount: [null as number | null, [Validators.required, Validators.min(0.01)]],
    transactionType: ['Expense' as TransactionType, Validators.required],
    mainCategory: ['', Validators.required],
    subcategory: ['', Validators.required],
    paymentMethod: ['', Validators.required],
    notes: [''],
  });

  constructor() {
    this.form.controls.transactionType.valueChanges.subscribe(() => {
      this.form.controls.mainCategory.reset('');
      this.form.controls.subcategory.reset('');
    });
    this.form.controls.mainCategory.valueChanges.subscribe(() => {
      this.form.controls.subcategory.reset('');
    });
  }

  protected get mainCategories(): string[] {
    const type = this.form.controls.transactionType.value ?? 'Expense';
    return Object.keys(CATEGORY_OPTIONS[type]);
  }

  protected get canEnterTransactions(): boolean {
    return this.csv.status() === 'connected' || this.csv.status() === 'unsupported';
  }

  protected get subcategories(): readonly string[] {
    const type = this.form.controls.transactionType.value ?? 'Expense';
    const category = this.form.controls.mainCategory.value ?? '';
    return CATEGORY_OPTIONS[type][category] ?? [];
  }

  protected async submitForm(): Promise<void> {
    if (this.saving()) return;
    this.formMessage.set('');
    this.formMessageType.set('');
    if (!this.canEnterTransactions) {
      this.setFormMessage('Please select or create a CSV file before adding a transaction.', 'error');
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.setFormMessage('Check the highlighted fields and complete the required information.', 'error');
      return;
    }
    const value = this.form.getRawValue();
    const transaction: Transaction = {
      date: value.date!,
      amount: value.amount as number,
      transactionType: value.transactionType!,
      mainCategory: value.mainCategory!,
      subcategory: value.subcategory!,
      paymentMethod: value.paymentMethod!,
      notes: value.notes ?? '',
    };

    this.saving.set(true);
    try {
      const result = await this.csv.appendTransaction(transaction);
      this.setFormMessage(
        result === 'saved'
          ? 'Transaction added to the connected CSV file.'
          : 'Transaction added. Download the updated CSV and keep it as your latest copy.',
        'success',
      );
      this.form.reset({
        date: this.today(),
        amount: null,
        transactionType: 'Expense',
        mainCategory: '',
        subcategory: '',
        paymentMethod: '',
        notes: '',
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const message = code === 'no-file'
        ? 'Please select or create a CSV file before adding a transaction.'
        : code === 'permission-denied'
          ? 'File access permission was denied. Please select the CSV file again.'
          : code === 'invalid-csv'
            ? 'The selected CSV does not match the required transaction format.'
            : code === 'file-not-found'
              ? 'The selected CSV file could not be found. Please select it again.'
            : code === 'create-file-failure'
                ? 'The new CSV file could not be created. Please choose a writable location and try again.'
              : code === 'open-file-failure'
                ? 'The CSV file could not be read. Please check access and select it again.'
              : 'The transaction could not be written to the CSV file. Please try again.';
      this.setFormMessage(message, 'error');
    } finally {
      this.saving.set(false);
    }
  }

  protected async selectFile(): Promise<void> {
    await this.runFileAction(() => this.csv.selectCsvFile());
  }

  protected async createFile(): Promise<void> {
    await this.runFileAction(() => this.csv.createCsvFile());
  }

  protected disconnect(): void {
    this.csv.disconnect();
    this.setMessage('CSV file disconnected.', 'success');
  }

  private async runFileAction(action: () => Promise<void>): Promise<void> {
    this.message.set('');
    this.messageType.set('');
    try {
      await action();
      this.setMessage('CSV file is ready. Its existing data has been preserved.', 'success');
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      const code = error instanceof Error ? error.message : '';
      const message = code === 'invalid-csv'
        ? 'The selected CSV does not match the required transaction format.'
        : code === 'permission-denied'
          ? 'File access permission was denied. Please select the CSV file again.'
          : code === 'create-file-failure'
            ? 'The new CSV file could not be created. Please choose a writable location and try again.'
            : code === 'open-file-failure'
              ? 'The CSV file could not be read. Please check access and select it again.'
          : code === 'unsupported'
            ? 'Direct CSV editing is not supported in this browser. Use the download option to create your CSV.'
            : 'The CSV file could not be opened. Please try again.';
      this.setMessage(message, 'error');
    }
  }

  private setMessage(message: string, type: 'success' | 'error'): void {
    this.message.set(message);
    this.messageType.set(type);
  }

  private setFormMessage(message: string, type: 'success' | 'error'): void {
    this.formMessage.set(message);
    this.formMessageType.set(type);
  }

  private today(): string {
    const now = new Date();
    const offset = now.getTimezoneOffset() * 60_000;
    return new Date(now.getTime() - offset).toISOString().slice(0, 10);
  }
}
