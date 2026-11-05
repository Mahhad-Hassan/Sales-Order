import { Injectable, inject } from '@angular/core';
import { EMPTY, expand, forkJoin, map, Observable, of, reduce, shareReplay, tap } from 'rxjs';
import {
  CompanyOption,
  IncotermOption,
  ItemPriceOption,
  PaymentTermOption,
  SalesOrderItemOption,
  SalesOrderListOption,
  SalesOrderRecord,
  SellingPriceListOption,
  WarehouseOption,
} from '../models/sales-order.model';
import { FrappeDocTypeMetadata } from '../models/frappe-api.model';
import { FrappeApiService } from './frappe-api.service';

@Injectable({ providedIn: 'root' })
export class FrappeSalesOrderService {
  private readonly api = inject(FrappeApiService);
  private readonly itemPrices = new Map<string, Observable<ItemPriceOption[]>>();

  loadOptions(): Observable<{
    companies: CompanyOption[];
    warehouses: WarehouseOption[];
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
      warehouses: this.api.getList<WarehouseOption>(
        'Warehouse',
        ['name', 'warehouse_name', 'company', 'is_group', 'disabled'],
        [['disabled', '=', 0], ['is_group', '=', 0]],
        1000,
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
        ['name', 'customer', 'customer_name', 'transaction_date', 'delivery_date', 'grand_total', 'currency', 'status', 'docstatus'],
        [],
        100,
      ),
      salesOrderMetadata: this.api.getDocument<FrappeDocTypeMetadata>('DocType', 'Sales Order'),
    });
  }

  getSalesOrder(name: string): Observable<SalesOrderRecord> {
    return this.api.getDocument<SalesOrderRecord>('Sales Order', name);
  }

  getAllSalesOrders(): Observable<SalesOrderListOption[]> {
    const pageSize = 500;
    const fields = [
      'name',
      'customer',
      'customer_name',
      'transaction_date',
      'delivery_date',
      'grand_total',
      'currency',
      'status',
      'docstatus',
    ];
    return this.api.getList<SalesOrderListOption>('Sales Order', fields, [], pageSize).pipe(
      expand((page, index) => page.length === pageSize
        ? this.api.getList<SalesOrderListOption>('Sales Order', fields, [], pageSize, (index + 1) * pageSize)
        : EMPTY),
      reduce((orders, page) => {
        orders.push(...page);
        return orders;
      }, [] as SalesOrderListOption[]),
    );
  }

  getPaymentTerm(name: string): Observable<PaymentTermOption> {
    return this.api.getDocument<PaymentTermOption>('Payment Term', name);
  }

  getIncoterm(name: string): Observable<IncotermOption> {
    return this.api.getDocument<IncotermOption>('Incoterm', name);
  }

  getItemPrices(itemCode: string, priceList: string): Observable<ItemPriceOption[]> {
    const cacheKey = JSON.stringify([itemCode, priceList]);
    const cached = this.itemPrices.get(cacheKey);
    if (cached) {
      return cached;
    }

    const request = this.api.getList<ItemPriceOption>(
      'Item Price',
      ['name', 'item_code', 'price_list', 'price_list_rate', 'uom', 'valid_from', 'valid_upto', 'selling'],
      [['item_code', '=', itemCode], ['price_list', '=', priceList], ['selling', '=', 1]],
      100,
    ).pipe(
      tap({
        error: () => this.itemPrices.delete(cacheKey),
      }),
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.itemPrices.set(cacheKey, request);
    return request;
  }

  submitSalesOrder(order: SalesOrderRecord): Observable<SalesOrderRecord> {
    return this.api.callMethod<SalesOrderRecord>('frappe.client.submit', {
      doc: JSON.stringify(order),
    });
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
