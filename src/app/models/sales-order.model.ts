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
  description?: string;
  qty: number;
  uom?: string;
  stock_uom?: string;
  rate: number;
  discount_amount?: number;
  amount?: number;
  net_amount?: number;
}

export interface SalesOrderTaxRecord extends Record<string, unknown> {
  description?: string;
  account_head?: string;
  charge_type?: string;
  rate?: number;
  tax_amount?: number;
  total?: number;
}

export interface SalesOrderRecord extends Record<string, unknown> {
  name: string;
  docstatus: number;
  customer: string;
  customer_name?: string;
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
  status?: string;
  total?: number;
  total_taxes_and_charges?: number;
  grand_total?: number;
  rounded_total?: number;
  in_words?: string;
  customer_address?: string;
  shipping_address_name?: string;
  shipping_address?: string;
  address_display?: string;
  contact_person?: string;
  contact_mobile?: string;
  contact_email?: string;
  taxes?: SalesOrderTaxRecord[];
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

export interface ItemPriceOption {
  name: string;
  item_code: string;
  price_list: string;
  price_list_rate: number;
  uom?: string | null;
  valid_from?: string | null;
  valid_upto?: string | null;
  selling?: number;
}

export interface SalesOrderListOption {
  name: string;
  customer: string;
  customer_name?: string;
  transaction_date: string;
  delivery_date?: string | null;
  grand_total?: number;
  currency?: string;
  status?: string;
  docstatus: number;
}
