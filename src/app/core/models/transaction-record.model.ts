import { Transaction } from './transaction.model';

export interface TransactionRecord extends Transaction {
  id: number;
  createdAt: number;
}
