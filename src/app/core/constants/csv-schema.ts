export const CSV_HEADERS = [
  'Date',
  'Amount',
  'Transaction Type',
  'Main Category',
  'Subcategory',
  'Payment Method',
  'Description / Notes',
] as const;

export const CSV_HEADER_ROW = CSV_HEADERS.join(',');

export const LEGACY_CSV_HEADERS = [
  'Date',
  'Amount',
  'Transaction Type',
  'Main Category',
  'Subcategory',
  'Merchant / Payee',
  'Account',
  'Payment Method',
  'Description / Notes',
] as const;
