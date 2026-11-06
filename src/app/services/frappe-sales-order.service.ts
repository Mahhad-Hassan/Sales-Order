import { Injectable, inject } from '@angular/core';
import { EMPTY, concatMap, expand, forkJoin, from, map, mergeMap, Observable, of, reduce, switchMap, tap } from 'rxjs';
import {
  CompanyOption,
  AssignmentUserGroupOption,
  AssignmentUserOption,
  IncotermOption,
  ItemPriceOption,
  LinkedDocumentItem,
  LinkedDocumentStatus,
  PaymentTermOption,
  SalesOrderItemOption,
  SalesOrderListOption,
  SalesOrderRecord,
  SellingPriceListOption,
  WorkflowConfiguration,
  WorkflowTransition,
  WorkflowStateOption,
} from '../models/sales-order.model';
import { FrappeDocTypeMetadata } from '../models/frappe-api.model';
import { FrappeApiService } from './frappe-api.service';

@Injectable({ providedIn: 'root' })
export class FrappeSalesOrderService {
  private readonly api = inject(FrappeApiService);
  private salesInvoiceOrderField: 'sales_order' | 'against_sales_order' | null = null;

  loadOptions(): Observable<{
    companies: CompanyOption[];
    incoterms: IncotermOption[];
    items: SalesOrderItemOption[];
    paymentTerms: PaymentTermOption[];
    priceLists: SellingPriceListOption[];
    orders: SalesOrderListOption[];
    salesOrderMetadata: FrappeDocTypeMetadata;
    salesOrderWorkflowStateField: string | null;
  }> {
    return forkJoin({
      companies: this.api.getList<CompanyOption>(
        'Company',
        ['name', 'default_currency', 'default_warehouse'],
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
        ['name', 'customer', 'customer_name', 'transaction_date', 'delivery_date', 'total', 'grand_total', 'currency', 'status', 'docstatus'],
        [],
        100,
      ),
      salesOrderMetadata: this.api.getDocument<FrappeDocTypeMetadata>('DocType', 'Sales Order'),
      salesOrderWorkflowStateField: this.getActiveWorkflowStateField('Sales Order'),
    });
  }

  getSalesOrder(name: string): Observable<SalesOrderRecord> {
    return this.api.getDocument<SalesOrderRecord>('Sales Order', name);
  }

  getSalesOrderWorkflowTransitions(name: string): Observable<WorkflowTransition[]> {
    return this.api.callMethod<WorkflowTransition[]>('frappe.model.workflow.get_transitions', {
      doc: JSON.stringify({ doctype: 'Sales Order', name }),
    });
  }

  applySalesOrderWorkflowAction(name: string, action: string): Observable<SalesOrderRecord> {
    return this.api.callMethod<SalesOrderRecord>('frappe.model.workflow.apply_workflow', {
      doc: JSON.stringify({ doctype: 'Sales Order', name }),
      action,
    }).pipe(switchMap(() => this.getSalesOrder(name)));
  }

  getAssignmentOptions(): Observable<{
    users: AssignmentUserOption[];
    userGroups: AssignmentUserGroupOption[];
  }> {
    return forkJoin({
      users: this.api.getList<AssignmentUserOption>(
        'User',
        ['name', 'full_name'],
        [['enabled', '=', 1], ['user_type', '=', 'System User']],
        500,
      ),
      userGroups: this.api.getList<AssignmentUserGroupOption>('User Group', ['name'], [], 500),
    });
  }

  getUserGroupMembers(groupName: string): Observable<string[]> {
    return this.api.getDocument<{
      user_group_members?: Array<{ user?: string | null }>;
    }>('User Group', groupName).pipe(
      map((group) => [...new Set((group.user_group_members ?? [])
        .map((member) => member.user?.trim())
        .filter((user): user is string => Boolean(user)))]),
    );
  }

  assignSalesOrder(
    name: string,
    assignment: {
      assignTo: string[];
      date: string;
      priority: 'Low' | 'Medium' | 'High';
      description: string;
    },
  ): Observable<unknown> {
    return this.api.callMethod<unknown>('frappe.desk.form.assign_to.add', {
      doctype: 'Sales Order',
      name,
      assign_to: JSON.stringify(assignment.assignTo),
      date: assignment.date || null,
      priority: assignment.priority,
      description: assignment.description,
      notify: true,
    });
  }

  getItemUoms(itemCode: string): Observable<string[]> {
    return this.api.getDocument<{
      stock_uom?: string;
      uoms?: Array<{ uom?: string | null }>;
    }>('Item', itemCode).pipe(
      map((item) => [...new Set([
        item.stock_uom,
        ...(item.uoms ?? []).map((row) => row.uom),
      ].filter((uom): uom is string => typeof uom === 'string' && Boolean(uom.trim())))]),
    );
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
          throw new Error(`Multiple active ${doctype} workflows use different state fields. Please check the workflow configuration.`);
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
      salesInvoices: this.getSalesInvoiceOrderField().pipe(
        switchMap((salesOrderField) => this.getStatusesForLinkedDocuments(
          'Sales Invoice Item',
          'Sales Invoice',
          salesOrderField,
          salesOrderNames,
        )),
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

  private getSalesInvoiceOrderField(): Observable<'sales_order' | 'against_sales_order'> {
    if (this.salesInvoiceOrderField) {
      return of(this.salesInvoiceOrderField);
    }

    return this.api.getDocument<FrappeDocTypeMetadata>('DocType', 'Sales Invoice Item').pipe(
      map((metadata) => {
        const availableFields = new Set(metadata.fields.map((field) => field.fieldname));
        const relationshipField = (['sales_order', 'against_sales_order'] as const)
          .find((field) => availableFields.has(field));
        if (!relationshipField) {
          throw new Error('Sales Invoice Item does not expose a Sales Order relationship field.');
        }
        return relationshipField;
      }),
      tap((field) => {
        this.salesInvoiceOrderField = field;
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
                  document.docstatus === 0 || document.docstatus === 2
                    ? this.documentStatus(document.docstatus)
                    : (workflowStateField ? this.readStringField(document, workflowStateField) : '')
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
    return this.getAllPages<ItemPriceOption>(
      'Item Price',
      ['name', 'item_code', 'price_list', 'price_list_rate', 'uom', 'valid_from', 'valid_upto', 'selling'],
      [['item_code', '=', itemCode], ['price_list', '=', priceList], ['selling', '=', 1]],
    );
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
