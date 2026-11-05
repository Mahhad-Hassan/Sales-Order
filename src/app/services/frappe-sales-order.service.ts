import { Injectable, inject } from '@angular/core';
import { EMPTY, concatMap, expand, forkJoin, from, map, mergeMap, Observable, of, reduce, shareReplay, switchMap, tap } from 'rxjs';
import {
  CompanyOption,
  IncotermOption,
  ItemPriceOption,
  LinkedDocumentItem,
  LinkedDocumentStatus,
  PaymentTermOption,
  SalesOrderItemOption,
  SalesOrderListOption,
  SalesOrderRecord,
  SellingPriceListOption,
  WarehouseOption,
  WorkflowConfiguration,
  WorkflowStateOption,
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
        ['name', 'customer', 'customer_name', 'transaction_date', 'delivery_date', 'total', 'grand_total', 'currency', 'status', 'docstatus'],
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
    return this.getActiveWorkflowStateField('Sales Order').pipe(
      switchMap((workflowStateField) => {
        const fields = [
          'name',
          'customer',
          'customer_name',
          'transaction_date',
          'delivery_date',
          'total',
          'grand_total',
          'currency',
          'status',
          'docstatus',
          ...(workflowStateField ? [workflowStateField] : []),
        ];
        return this.getAllPages<SalesOrderListOption>('Sales Order', fields, []).pipe(
          map((orders) => orders.map((order) => ({
            ...order,
            salesOrderStatus: workflowStateField
              ? this.readStringField(order, workflowStateField) || order.status || this.documentStatus(order.docstatus)
              : order.status || this.documentStatus(order.docstatus),
          }))),
        );
      }),
    );
  }

  getSalesOrderStatuses(salesOrderNames: string[]): Observable<Record<string, string>> {
    if (!salesOrderNames.length) {
      return of({});
    }

    return this.getActiveWorkflowStateField('Sales Order').pipe(
      switchMap((workflowStateField) => from(this.chunks(salesOrderNames, 50)).pipe(
        concatMap((chunk) => this.getAllPages<SalesOrderListOption>(
          'Sales Order',
          ['name', 'status', 'docstatus', ...(workflowStateField ? [workflowStateField] : [])],
          [['name', 'in', chunk]],
        )),
        reduce((documents, page) => {
          documents.push(...page);
          return documents;
        }, [] as SalesOrderListOption[]),
        map((documents) => Object.fromEntries(documents.map((order) => [
          order.name,
          (workflowStateField ? this.readStringField(order, workflowStateField) : '')
            || order.status
            || this.documentStatus(order.docstatus),
        ]))),
      )),
    );
  }

  getWorkflowStateStyles(): Observable<Record<string, string>> {
    return this.api.getList<WorkflowStateOption>(
      'Workflow State',
      ['name', 'style'],
      [],
      1000,
    ).pipe(
      map((states) => Object.fromEntries(states.map((state) => [
        state.name,
        state.style?.trim() ?? '',
      ]))),
    );
  }

  private getActiveWorkflowStateField(doctype: string): Observable<string | null> {
    return this.api.getList<WorkflowConfiguration>(
      'Workflow',
      ['name', 'document_type', 'workflow_state_field', 'is_active'],
      [['document_type', '=', doctype], ['is_active', '=', 1]],
      100,
    ).pipe(
      map((workflows) => {
        const fields = [...new Set(workflows
          .map((workflow) => workflow.workflow_state_field?.trim())
          .filter((field): field is string => Boolean(field)))];
        if (fields.length > 1) {
          throw new Error(`Multiple active ${doctype} workflows use different state fields. Please check the Frappe workflow configuration.`);
        }
        return fields[0] ?? null;
      }),
    );
  }

  private readStringField(record: Record<string, unknown>, fieldName: string): string {
    const value = record[fieldName];
    return typeof value === 'string' ? value.trim() : '';
  }

  getLinkedDocumentStatuses(
    salesOrderNames: string[],
  ): Observable<Record<string, {
    deliveryNoteStatus: string;
    salesInvoiceStatus: string;
  }>> {
    if (!salesOrderNames.length) {
      return of({});
    }

    return forkJoin({
      deliveryNotes: this.getStatusesForLinkedDocuments(
        'Delivery Note Item',
        'Delivery Note',
        'against_sales_order',
        salesOrderNames,
      ),
      salesInvoices: this.getStatusesForLinkedDocuments(
        'Sales Invoice Item',
        'Sales Invoice',
        'sales_order',
        salesOrderNames,
      ),
    }).pipe(
      map(({ deliveryNotes, salesInvoices }) => {
        const statuses: Record<string, {
          deliveryNoteStatus: string;
          salesInvoiceStatus: string;
        }> = {};
        for (const name of salesOrderNames) {
          statuses[name] = {
            deliveryNoteStatus: deliveryNotes[name] ?? '—',
            salesInvoiceStatus: salesInvoices[name] ?? '—',
          };
        }
        return statuses;
      }),
    );
  }

  private getStatusesForLinkedDocuments(
    childDocType: string,
    parentDocType: string,
    salesOrderField: 'against_sales_order' | 'sales_order',
    salesOrderNames: string[],
  ): Observable<Record<string, string>> {
    return this.getActiveWorkflowStateField(parentDocType).pipe(
      switchMap((workflowStateField) => {
        const salesOrderChunks = this.chunks(salesOrderNames, 50);
        return from(salesOrderChunks).pipe(
          concatMap((chunk) => this.getAllPages<Pick<LinkedDocumentItem, 'name'>>(
            childDocType,
            ['name'],
            [[salesOrderField, 'in', chunk]],
          )),
          reduce((items, page) => {
            items.push(...page);
            return items;
          }, [] as Array<Pick<LinkedDocumentItem, 'name'>>),
          switchMap((childDocuments) => from(childDocuments).pipe(
            mergeMap((child) => this.api.getDocument<LinkedDocumentItem>(childDocType, child.name), 8),
            reduce((items, item) => {
              items.push(item);
              return items;
            }, [] as LinkedDocumentItem[]),
          )),
          switchMap((items) => {
            const salesOrdersByParent = new Map<string, Set<string>>();
            for (const item of items) {
              const salesOrderName = item[salesOrderField];
              if (!item.parent || !salesOrderName) {
                continue;
              }
              const linkedOrders = salesOrdersByParent.get(item.parent) ?? new Set<string>();
              linkedOrders.add(salesOrderName);
              salesOrdersByParent.set(item.parent, linkedOrders);
            }

            const parentNames = [...salesOrdersByParent.keys()];
            if (!parentNames.length) {
              return of({});
            }

            const documentFields = [
              'name',
              'status',
              'docstatus',
              ...(workflowStateField ? [workflowStateField] : []),
            ];
            return from(this.chunks(parentNames, 50)).pipe(
              concatMap((chunk) => this.getAllPages<LinkedDocumentStatus>(
                parentDocType,
                documentFields,
                [['name', 'in', chunk]],
              )),
              reduce((documents, page) => {
                documents.push(...page);
                return documents;
              }, [] as LinkedDocumentStatus[]),
              map((documents) => {
                const statusBySalesOrder = new Map<string, Set<string>>();
                const statusByParent = new Map(documents.map((document) => [
                  document.name,
                  (workflowStateField ? this.readStringField(document, workflowStateField) : '')
                    || document.status
                    || this.documentStatus(document.docstatus),
                ]));
                for (const [parentName, linkedSalesOrders] of salesOrdersByParent) {
                  const status = statusByParent.get(parentName);
                  if (!status) {
                    continue;
                  }
                  for (const salesOrderName of linkedSalesOrders) {
                    const statuses = statusBySalesOrder.get(salesOrderName) ?? new Set<string>();
                    statuses.add(status);
                    statusBySalesOrder.set(salesOrderName, statuses);
                  }
                }
                return Object.fromEntries([...statusBySalesOrder].map(([name, statuses]) => [
                  name,
                  [...statuses].join(', '),
                ]));
              }),
            );
          }),
        );
      }),
    );
  }

  private getAllPages<T>(
    doctype: string,
    fields: string[],
    filters: unknown[][],
  ): Observable<T[]> {
    const pageSize = 500;
    return this.api.getList<T>(doctype, fields, filters, pageSize).pipe(
      expand((page, index) => page.length === pageSize
        ? this.api.getList<T>(doctype, fields, filters, pageSize, (index + 1) * pageSize)
        : EMPTY),
      reduce((records, page) => {
        records.push(...page);
        return records;
      }, [] as T[]),
    );
  }

  private chunks<T>(values: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let index = 0; index < values.length; index += size) {
      chunks.push(values.slice(index, index + size));
    }
    return chunks;
  }

  private documentStatus(docstatus: number): string {
    return docstatus === 1 ? 'Submitted' : docstatus === 2 ? 'Cancelled' : 'Draft';
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
