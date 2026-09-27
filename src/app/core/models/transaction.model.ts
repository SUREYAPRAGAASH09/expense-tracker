export const TRANSACTION_TYPES = ['Expense', 'Income', 'Transfer', 'Refund'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export interface Transaction {
  date: string;
  amount: number;
  transactionType: TransactionType;
  mainCategory: string;
  subcategory: string;
  paymentMethod: string;
  notes: string;
}
