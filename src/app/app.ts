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
  protected readonly dateFilter = signal<'all' | 'year' | 'month' | 'custom'>('all');
  protected readonly selectedYear = signal(String(new Date().getFullYear()));
  protected readonly selectedMonth = signal('01');
  protected readonly customStartDate = signal('');
  protected readonly customEndDate = signal('');
  protected readonly transactionTypeFilter = signal<'all' | TransactionType>('all');
  protected readonly categoryFilter = signal('all');
  protected readonly subcategoryFilter = signal('all');
  protected readonly paymentMethodFilter = signal('all');
  protected readonly currentPage = signal(1);
  protected readonly pageSize = signal(10);
  protected readonly pageSizes = [10, 25, 50];
  protected readonly months = [
    { value: '01', label: 'January' }, { value: '02', label: 'February' },
    { value: '03', label: 'March' }, { value: '04', label: 'April' },
    { value: '05', label: 'May' }, { value: '06', label: 'June' },
    { value: '07', label: 'July' }, { value: '08', label: 'August' },
    { value: '09', label: 'September' }, { value: '10', label: 'October' },
    { value: '11', label: 'November' }, { value: '12', label: 'December' },
  ];
  private readonly formBuilder = inject(FormBuilder);
  protected readonly transactionTypes = TRANSACTION_TYPES;
  protected readonly paymentMethods = PAYMENT_METHODS;
  protected readonly message = signal('');
  protected readonly messageType = signal<'success' | 'error' | ''>('');
  protected readonly formMessage = signal('');
  protected readonly formMessageType = signal<'success' | 'error' | ''>('');
  protected readonly saving = signal(false);
  protected readonly submitAttempted = signal(false);
  protected readonly installPrompt = signal<InstallPromptEvent | null>(null);
  protected readonly tourActive = signal(false);
  protected readonly tourIndex = signal(0);
  protected readonly tourPosition = signal({ top: 16, left: 16 });
  protected readonly tourSpotlight = signal<{
    top: number; left: number; width: number; height: number;
    viewportWidth: number; viewportHeight: number;
  } | null>(null);
  protected readonly tourSteps = [
    { target: 'storage', title: 'Your data stays on this device', body: 'Transactions are saved in this browser on this device. Use a CSV backup to keep or transfer a copy.' },
    { target: 'entry', title: 'Add a transaction', body: 'Open this panel to enter an expense, income, transfer, or refund. Required fields are marked with an asterisk.' },
    { target: 'filters', title: 'Find transactions', body: 'Combine date, year, month, custom dates, transaction type, category, subcategory, and payment method filters.' },
    { target: 'totals', title: 'Review totals', body: 'These totals summarize the transactions that match your current filters.' },
    { target: 'table', title: 'View transaction details', body: 'Matching transactions appear here, newest dates first. On a phone, swipe sideways to see every column.' },
  ] as const;
  private autoTourChecked = false;
  protected readonly form = this.formBuilder.group({
    date: ['', Validators.required],
    amount: [null as number | null, [Validators.required, Validators.min(0.01)]],
    transactionType: ['' as TransactionType | '', Validators.required],
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
    const type = this.form.controls.transactionType.value;
    if (!type) return [];
    return Object.keys(CATEGORY_OPTIONS[type]);
  }

  protected get canEnterTransactions(): boolean {
    return this.database.status() === 'ready';
  }

  protected get subcategories(): readonly string[] {
    const type = this.form.controls.transactionType.value;
    if (!type) return [];
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
      this.submitAttempted.set(true);
      this.form.markAllAsTouched();
      this.setFormMessage('Check the highlighted fields and complete the required information.', 'error');
      return;
    }
    const value = this.form.getRawValue();
    const transaction: Transaction = {
      date: value.date!,
      amount: value.amount as number,
      transactionType: value.transactionType as TransactionType,
      mainCategory: value.mainCategory!,
      subcategory: value.subcategory!,
      paymentMethod: value.paymentMethod!,
      notes: value.notes ?? '',
    };

    this.saving.set(true);
    try {
      const saved = await this.database.add(transaction);
      this.transactions.update((items) => [saved, ...items]);
      this.currentPage.set(1);
      this.setFormMessage('Transaction saved on this device.', 'success');
      this.form.reset({
        date: '',
        amount: null,
        transactionType: '',
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

  protected get transactionYears(): string[] {
    return [...new Set([
      this.selectedYear(),
      ...this.transactions().map((item) => item.date.slice(0, 4)).filter((year) => /^\d{4}$/.test(year)),
    ])].sort().reverse();
  }

  protected get filteredTransactions(): TransactionRecord[] {
    const mode = this.dateFilter();
    const year = this.selectedYear();
    const month = this.selectedMonth();
    const start = this.customStartDate();
    const end = this.customEndDate();
    return this.transactions()
      .filter((item) => {
        if (mode === 'year') return item.date.startsWith(`${year}-`);
        if (mode === 'month') return item.date.startsWith(`${year}-${month}-`);
        if (mode === 'custom') return (!start || item.date >= start) && (!end || item.date <= end);
        return true;
      })
      .filter((item) => this.transactionTypeFilter() === 'all' || item.transactionType === this.transactionTypeFilter())
      .filter((item) => this.categoryFilter() === 'all' || item.mainCategory === this.categoryFilter())
      .filter((item) => this.subcategoryFilter() === 'all' || item.subcategory === this.subcategoryFilter())
      .filter((item) => this.paymentMethodFilter() === 'all' || item.paymentMethod === this.paymentMethodFilter())
      .sort((first, second) => second.date.localeCompare(first.date) || second.id - first.id);
  }

  protected get filterCategories(): string[] {
    return [...new Set(this.transactions()
      .filter((item) => this.transactionTypeFilter() === 'all' || item.transactionType === this.transactionTypeFilter())
      .map((item) => item.mainCategory))].sort();
  }

  protected get filterSubcategories(): string[] {
    return [...new Set(this.transactions()
      .filter((item) => this.transactionTypeFilter() === 'all' || item.transactionType === this.transactionTypeFilter())
      .filter((item) => this.categoryFilter() === 'all' || item.mainCategory === this.categoryFilter())
      .map((item) => item.subcategory))].sort();
  }

  protected get filterPaymentMethods(): string[] {
    return [...new Set(this.transactions().map((item) => item.paymentMethod))].sort();
  }

  protected get transactionTotals(): Record<TransactionType, number> {
    return this.filteredTransactions.reduce((totals, item) => {
      totals[item.transactionType] += item.amount;
      return totals;
    }, { Expense: 0, Income: 0, Transfer: 0, Refund: 0 });
  }

  protected get totalPages(): number {
    return Math.max(1, Math.ceil(this.filteredTransactions.length / this.pageSize()));
  }

  protected get paginatedTransactions(): TransactionRecord[] {
    const start = (this.currentPage() - 1) * this.pageSize();
    return this.filteredTransactions.slice(start, start + this.pageSize());
  }

  protected get pageRangeStart(): number {
    return this.filteredTransactions.length ? (this.currentPage() - 1) * this.pageSize() + 1 : 0;
  }

  protected get pageRangeEnd(): number {
    return Math.min(this.currentPage() * this.pageSize(), this.filteredTransactions.length);
  }

  protected setDateFilter(event: Event): void {
    this.dateFilter.set((event.target as HTMLSelectElement).value as 'all' | 'year' | 'month' | 'custom');
    this.currentPage.set(1);
  }

  protected setSelectedYear(event: Event): void {
    this.selectedYear.set((event.target as HTMLSelectElement).value);
    this.currentPage.set(1);
  }

  protected setSelectedMonth(event: Event): void {
    this.selectedMonth.set((event.target as HTMLSelectElement).value);
    this.currentPage.set(1);
  }

  protected setCustomStartDate(event: Event): void {
    this.customStartDate.set((event.target as HTMLInputElement).value);
    this.currentPage.set(1);
  }

  protected setCustomEndDate(event: Event): void {
    this.customEndDate.set((event.target as HTMLInputElement).value);
    this.currentPage.set(1);
  }

  protected setTransactionTypeFilter(event: Event): void {
    this.transactionTypeFilter.set((event.target as HTMLSelectElement).value as 'all' | TransactionType);
    this.categoryFilter.set('all');
    this.subcategoryFilter.set('all');
    this.currentPage.set(1);
  }

  protected setCategoryFilter(event: Event): void {
    this.categoryFilter.set((event.target as HTMLSelectElement).value);
    this.subcategoryFilter.set('all');
    this.currentPage.set(1);
  }

  protected setSubcategoryFilter(event: Event): void {
    this.subcategoryFilter.set((event.target as HTMLSelectElement).value);
    this.currentPage.set(1);
  }

  protected setPaymentMethodFilter(event: Event): void {
    this.paymentMethodFilter.set((event.target as HTMLSelectElement).value);
    this.currentPage.set(1);
  }

  protected setPageSize(event: Event): void {
    this.pageSize.set(Number((event.target as HTMLSelectElement).value));
    this.currentPage.set(1);
  }

  protected changePage(delta: number): void {
    this.currentPage.update((page) => Math.min(this.totalPages, Math.max(1, page + delta)));
  }

  protected get currentTourStep(): (typeof this.tourSteps)[number] {
    return this.tourSteps[this.tourIndex()];
  }

  protected isTourTarget(target: string): boolean {
    return this.tourActive() && this.currentTourStep.target === target;
  }

  protected startTour(): void {
    this.tourIndex.set(0);
    this.tourActive.set(true);
    this.tourSpotlight.set(null);
    const cardWidth = Math.min(430, window.innerWidth - 24);
    this.tourPosition.set({
      top: Math.max(12, (window.innerHeight - 280) / 2),
      left: Math.max(12, (window.innerWidth - cardWidth) / 2),
    });
    window.setTimeout(() => {
      document.getElementById('tour-skip')?.focus();
      this.scrollToTourTarget();
    }, 0);
  }

  protected previousTourStep(): void {
    this.tourIndex.update((index) => Math.max(0, index - 1));
    this.scrollToTourTarget();
  }

  protected nextTourStep(): void {
    if (this.tourIndex() >= this.tourSteps.length - 1) {
      this.closeTour();
      return;
    }
    this.tourIndex.update((index) => index + 1);
    this.scrollToTourTarget();
  }

  protected closeTour(): void {
    this.tourActive.set(false);
    this.tourSpotlight.set(null);
    try {
      localStorage.setItem('expense-tracker-tour-seen', 'true');
    } catch {
      // The tour still works for this visit if browser storage is unavailable.
    }
  }

  protected handleTourKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.closeTour();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.tour-dialog button:not(:disabled)')];
    if (!buttons.length) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private scrollToTourTarget(): void {
    window.setTimeout(() => {
      document.querySelector(`[data-tour="${this.currentTourStep.target}"]`)?.scrollIntoView({ behavior: 'auto', block: 'end' });
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => this.positionTourDialog()));
    }, 0);
  }

  protected positionTourDialog(): void {
    if (!this.tourActive()) return;
    const target = document.querySelector<HTMLElement>(`[data-tour="${this.currentTourStep.target}"]`);
    const dialog = document.querySelector<HTMLElement>('.tour-dialog');
    if (!target || !dialog) return;

    const targetRect = target.getBoundingClientRect();
    this.updateTourSpotlight(targetRect);
    const dialogRect = dialog.getBoundingClientRect();
    const gap = 24;
    const edge = 12;
    const width = Math.min(dialogRect.width || 430, window.innerWidth - edge * 2);
    const height = dialogRect.height;
    const centeredLeft = Math.min(Math.max(edge, targetRect.left + targetRect.width / 2 - width / 2), window.innerWidth - width - edge);
    const belowTop = targetRect.bottom + gap;
    const aboveTop = targetRect.top - height - gap;
    let top: number;
    let left = centeredLeft;

    if (belowTop + height <= window.innerHeight - edge) {
      top = belowTop;
    } else if (aboveTop >= edge) {
      top = aboveTop;
    } else if (window.innerWidth - targetRect.right >= width + gap) {
      left = targetRect.right + gap;
      top = Math.min(Math.max(edge, targetRect.top + targetRect.height / 2 - height / 2), window.innerHeight - height - edge);
    } else if (targetRect.left >= width + gap) {
      left = targetRect.left - width - gap;
      top = Math.min(Math.max(edge, targetRect.top + targetRect.height / 2 - height / 2), window.innerHeight - height - edge);
    } else {
      const availableBelow = window.innerHeight - targetRect.bottom;
      top = availableBelow >= targetRect.top ? belowTop : Math.max(edge, aboveTop);
      top = Math.min(top, window.innerHeight - height - edge);
    }

    this.tourPosition.set({ top, left });
  }

  protected updateTourSpotlight(rect: DOMRect): void {
    const padding = 10;
    const left = Math.max(0, rect.left - padding);
    const top = Math.max(0, rect.top - padding);
    const right = Math.min(window.innerWidth, rect.right + padding);
    const bottom = Math.min(window.innerHeight, rect.bottom + padding);
    this.tourSpotlight.set({
      top, left, width: right - left, height: bottom - top,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
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
      this.currentPage.set(1);
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
      this.maybeStartFirstTour();
    } catch {
      this.setMessage('Local storage could not be opened. Your transactions are unavailable in this browser.', 'error');
    }
  }

  private maybeStartFirstTour(): void {
    if (this.autoTourChecked) return;
    this.autoTourChecked = true;
    try {
      if (localStorage.getItem('expense-tracker-tour-seen') === 'true') return;
    } catch {
      // If local storage is unavailable, show the tour once during this page visit.
    }
    this.startTour();
  }

  private setMessage(message: string, type: 'success' | 'error'): void {
    this.message.set(message);
    this.messageType.set(type);
  }

  private setFormMessage(message: string, type: 'success' | 'error'): void {
    this.formMessage.set(message);
    this.formMessageType.set(type);
  }

}
