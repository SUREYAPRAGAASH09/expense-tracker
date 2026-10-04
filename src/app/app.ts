import { Component, inject, signal } from '@angular/core';
import { FormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { CsvFileService } from './core/services/csv-file.service';
import { TransactionDatabaseService } from './core/services/transaction-database.service';
import { CATEGORY_OPTIONS, PAYMENT_METHODS } from './core/constants/transaction-options';
import { TRANSACTION_TYPES, Transaction, TransactionType } from './core/models/transaction.model';
import { TransactionRecord } from './core/models/transaction-record.model';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

@Component({
  imports: [ReactiveFormsModule],
  selector: 'app-root',
  styleUrl: './app.css',
  templateUrl: './app.html',
})
export class App {
  protected readonly csv = inject(CsvFileService);
  protected readonly database = inject(TransactionDatabaseService);
  protected readonly transactions = signal<TransactionRecord[]>([]);
  private readonly formBuilder = inject(FormBuilder);
  protected readonly transactionTypes = TRANSACTION_TYPES;
  protected readonly paymentMethods = PAYMENT_METHODS;
  protected readonly message = signal('');
  protected readonly messageType = signal<'success' | 'error' | ''>('');
  protected readonly formMessage = signal('');
  protected readonly formMessageType = signal<'success' | 'error' | ''>('');
  protected readonly saving = signal(false);
  protected readonly installPrompt = signal<InstallPromptEvent | null>(null);
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
    window.addEventListener('beforeinstallprompt', (event: Event) => {
      event.preventDefault();
      this.installPrompt.set(event as InstallPromptEvent);
    });
    window.addEventListener('appinstalled', () => this.installPrompt.set(null));

    this.form.controls.transactionType.valueChanges.subscribe(() => {
      this.form.controls.mainCategory.reset('');
      this.form.controls.subcategory.reset('');
    });
    this.form.controls.mainCategory.valueChanges.subscribe(() => {
      this.form.controls.subcategory.reset('');
    });

    void this.loadTransactions();
  }

  protected get mainCategories(): string[] {
    const type = this.form.controls.transactionType.value ?? 'Expense';
    return Object.keys(CATEGORY_OPTIONS[type]);
  }

  protected get canEnterTransactions(): boolean {
    return this.database.status() === 'ready';
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
      this.setFormMessage('Local transaction storage is not ready. Reload the page and try again.', 'error');
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
      const saved = await this.database.add(transaction);
      this.transactions.update((items) => [saved, ...items]);
      this.setFormMessage('Transaction saved on this device.', 'success');
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
      const message = error instanceof DOMException && error.name === 'QuotaExceededError'
        ? 'Device storage is full. Export a CSV backup and free some space before trying again.'
        : 'The transaction could not be saved on this device. Please try again.';
      this.setFormMessage(message, 'error');
    } finally {
      this.saving.set(false);
    }
  }

  protected exportCsv(): void {
    this.csv.downloadTransactions(this.transactions());
    this.setMessage('CSV backup downloaded.', 'success');
  }

  protected async installApp(): Promise<void> {
    const prompt = this.installPrompt();
    if (!prompt) return;
    try {
      await prompt.prompt();
      await prompt.userChoice;
    } finally {
      this.installPrompt.set(null);
    }
  }

  protected async importCsv(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;

    try {
      const imported = await this.csv.readTransactions(file);
      const count = await this.database.addMany(imported);
      await this.loadTransactions();
      this.setMessage(`${count} transaction${count === 1 ? '' : 's'} imported into this device.`, 'success');
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      this.setMessage(code === 'invalid-csv'
        ? 'This CSV does not match the expected transaction format.'
        : 'The CSV could not be imported. Please check the file and try again.', 'error');
    }
  }

  private async loadTransactions(): Promise<void> {
    try {
      this.transactions.set(await this.database.initialize());
    } catch {
      this.setMessage('Local storage could not be opened. Your transactions are unavailable in this browser.', 'error');
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
