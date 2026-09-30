export interface Transaction {
  id: number;
  product: string;
  customer: string;
  year: number;
  month: string;
  quantity: number;
  total_value: number;
  extra: string;
}

export interface CustomField {
  name: string;
  field_type: string; // "text" | "number"
}
