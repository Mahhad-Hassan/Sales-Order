import { Injectable, inject } from '@angular/core';
import { forkJoin, map, Observable, of } from 'rxjs';
import {
  CompanyOption,
  IncotermOption,
  PaymentTermOption,
  SalesOrderItemOption,
  SalesOrderListOption,
  SalesOrderRecord,
  SellingPriceListOption,
} from '../models/sales-order.model';
import { FrappeDocTypeMetadata } from '../models/frappe-api.model';
import { FrappeApiService } from './frappe-api.service';

@Injectable({ providedIn: 'root' })
export class FrappeSalesOrderService {
  private readonly api = inject(FrappeApiService);

  loadOptions(): Observable<{
    companies: CompanyOption[];
    incoterms: IncotermOption[];
    items: SalesOrderItemOption[];
    paymentTerms: PaymentTermOption[];
    priceLists: SellingPriceListOption[];
    orders: SalesOrderListOption[];
    salesOrderMetadata: FrappeDocTypeMetadata;
  }> {
    return forkJoin({
      companies: this.api.getList<CompanyOption>(
        'Company',
        ['name', 'default_currency'],
        [],
        500,
      ),
      incoterms: this.api.getList<IncotermOption>('Incoterm', ['name', 'title'], [], 500),
      items: this.api.getList<SalesOrderItemOption>(
        'Item',
        ['item_code', 'item_name', 'stock_uom'],
        [],
        1000,
      ),
      paymentTerms: this.api.getList<PaymentTermOption>(
        'Payment Term',
        ['name', 'payment_term_name', 'due_date_based_on', 'credit_days', 'credit_months'],
        [],
        500,
      ),
      priceLists: this.api.getList<SellingPriceListOption>(
        'Price List',
        ['name', 'currency', 'selling', 'enabled'],
        [['selling', '=', 1], ['enabled', '=', 1]],
        500,
      ),
      orders: this.api.getList<SalesOrderListOption>(
        'Sales Order',
        ['name', 'customer', 'transaction_date', 'docstatus'],
        [],
        100,
      ),
      salesOrderMetadata: this.api.getDocument<FrappeDocTypeMetadata>('DocType', 'Sales Order'),
    });
  }

  getSalesOrder(name: string): Observable<SalesOrderRecord> {
    return this.api.getDocument<SalesOrderRecord>('Sales Order', name);
  }

  getPaymentTerm(name: string): Observable<PaymentTermOption> {
    return this.api.getDocument<PaymentTermOption>('Payment Term', name);
  }

  getIncoterm(name: string): Observable<IncotermOption> {
    return this.api.getDocument<IncotermOption>('Incoterm', name);
  }

  saveSalesOrder(
    document: Record<string, unknown>,
    name?: string,
  ): Observable<SalesOrderRecord> {
    return name
      ? this.api.updateDocument<SalesOrderRecord>('Sales Order', name, document)
      : this.api.createDocument<SalesOrderRecord>('Sales Order', document);
  }

  getExchangeRate(fromCurrency: string, toCurrency: string, date: string): Observable<number> {
    if (fromCurrency === toCurrency) {
      return of(1);
    }

    return this.api.getList<{ exchange_rate: number; date: string }>(
      'Currency Exchange',
      ['exchange_rate', 'date'],
      [
        ['from_currency', '=', fromCurrency],
        ['to_currency', '=', toCurrency],
        ['date', '<=', date],
      ],
      100,
    ).pipe(
      map((records) => {
        const latest = records
          .filter((record) => Number.isFinite(record.exchange_rate) && record.exchange_rate > 0)
          .sort((left, right) => right.date.localeCompare(left.date))[0];
        if (!latest) {
          throw new Error(`No ${fromCurrency} to ${toCurrency} exchange rate is configured for ${date}.`);
        }
        return latest.exchange_rate;
      }),
    );
  }
}
