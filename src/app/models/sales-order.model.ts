export interface PaymentTermOption {
  name: string;
  payment_term_name: string;
  due_date_based_on: string;
  credit_days: number | null;
  credit_months: number | null;
}

export interface IncotermOption {
  name: string;
  title: string;
}

export interface CompanyOption {
  name: string;
  default_currency: string;
}

export interface SellingPriceListOption {
  name: string;
  currency: string;
  selling: number;
  enabled: number;
}

export interface SalesOrderItemRecord {
  item_code: string;
  item_name?: string;
  qty: number;
  uom?: string;
  rate: number;
}

export interface SalesOrderRecord extends Record<string, unknown> {
  name: string;
  docstatus: number;
  customer: string;
  company: string;
  transaction_date: string;
  delivery_date?: string | null;
  currency: string;
  conversion_rate: number;
  selling_price_list: string;
  price_list_currency: string;
  plc_conversion_rate: number;
  incoterm?: string | null;
  payment_terms_template?: string | null;
  payment_schedule?: Array<{
    payment_term?: string;
    due_date?: string;
    credit_days?: number;
    credit_months?: number;
    invoice_portion?: number;
  }>;
  items: SalesOrderItemRecord[];
}

export interface SalesOrderItemOption {
  item_code: string;
  item_name: string;
  stock_uom: string;
}

export interface SalesOrderListOption {
  name: string;
  customer: string;
  transaction_date: string;
  docstatus: number;
}
