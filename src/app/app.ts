import { Component, DestroyRef, HostListener, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, finalize, forkJoin, of, switchMap, throwError, timeout } from 'rxjs';
import { CustomerAddressOption, CustomerOption, EMPTY_CUSTOMER_PARTY } from './models/customer-option.model';
import { calculatePaymentDueDate, formatDateForInput } from './models/payment-term-date';
import {
  CompanyOption,
  IncotermOption,
  ItemPriceOption,
  PaymentTermOption,
  SalesOrderItemOption,
  SalesOrderListOption,
  SalesOrderRecord,
  SalesOrderTaxRecord,
  SellingPriceListOption,
} from './models/sales-order.model';
import { FrappeAuthService } from './services/frappe-auth.service';
import { FrappeCustomerService } from './services/frappe-customer.service';
import { FrappeSalesOrderService } from './services/frappe-sales-order.service';

function mergeUniqueByName<T extends { name: string }>(...collections: T[][]): T[] {
  const options = new Map<string, T>();
  for (const collection of collections) {
    for (const option of collection) {
      if (!options.has(option.name)) {
        options.set(option.name, option);
      }
    }
  }
  return [...options.values()];
}

@Component({
  imports: [ReactiveFormsModule, RouterLink],
  selector: 'app-root',
  styleUrl: './app.scss',
  templateUrl: './sales-order.html',
})
export class App {
  private readonly formBuilder = inject(FormBuilder);
  private readonly auth = inject(FrappeAuthService);
  private readonly customerDirectory = inject(FrappeCustomerService);
  private readonly salesOrders = inject(FrappeSalesOrderService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly customerSearchRequests = new Subject<string>();
  private customerDetailsRequest = 0;
  private orderDetailsRequest = 0;
  private documentStatusRequest = 0;
  private activeCustomerName = '';
  private orderName = '';
  protected readonly orderDocstatus = signal(0);
  private namingSeries = '';
  private initializedOrderName = '';
  private loadedPaymentSchedule: NonNullable<SalesOrderRecord['payment_schedule']> = [];
  private loadedPaymentTermName = '';
  private readonly itemPriceRequestIds = new WeakMap<FormGroup, number>();
  private readonly itemUomRequestIds = new WeakMap<FormGroup, number>();
  private readonly itemUomsByRow = new WeakMap<FormGroup, string[]>();
  private readonly manualPriceEditIds = new WeakMap<FormGroup, number>();
  private readonly autoUnitPrices = new WeakMap<FormGroup, number>();
  private loadedSalesOrderSnapshot: SalesOrderRecord | null = null;
  private loadedCurrencySettings: Pick<
    SalesOrderRecord,
    'company' | 'selling_price_list' | 'currency' | 'conversion_rate' | 'price_list_currency' | 'plc_conversion_rate'
  > | null = null;

  protected readonly customerDropdownOpen = signal(false);
  protected readonly customerLoading = signal(false);
  protected readonly customerDetailsLoading = signal(false);
  protected readonly customerLoadError = signal('');
  protected readonly customerSearch = new FormControl('', { nonNullable: true });
  protected readonly customerOptions = signal<CustomerOption[]>([]);
  protected readonly selectedCustomerLabel = signal('');
  protected readonly currentOrderName = signal('');
  protected readonly billingAddressOptions = signal<CustomerAddressOption[]>([]);
  protected readonly shippingAddressOptions = signal<CustomerAddressOption[]>([]);
  protected readonly selectedBillingAddress = signal('');
  protected readonly selectedShippingAddress = signal('');
  protected readonly billingAddressDropdownOpen = signal(false);
  protected readonly shippingAddressDropdownOpen = signal(false);
  protected readonly customerEmails = signal<string[]>([]);
  protected readonly billingEmailDropdownOpen = signal(false);
  protected readonly shippingEmailDropdownOpen = signal(false);
  protected readonly companies = signal<CompanyOption[]>([]);
  protected readonly priceLists = signal<SellingPriceListOption[]>([]);
  protected readonly incoterms = signal<IncotermOption[]>([]);
  protected readonly paymentTerms = signal<PaymentTermOption[]>([]);
  protected readonly salesOrderOptions = signal<SalesOrderListOption[]>([]);
  protected readonly orderItems = signal<SalesOrderItemOption[]>([]);
  protected readonly orderTaxes = signal<SalesOrderTaxRecord[]>([]);
  protected readonly optionsLoading = signal(true);
  protected readonly orderLoading = signal(false);
  protected readonly savingOrder = signal(false);
  protected readonly orderError = signal('');
  protected readonly orderMessage = signal('');
  protected readonly documentStatuses = signal({
    salesOrder: 'Not Created',
    deliveryNote: 'Not Created',
    salesInvoice: 'Not Created',
  });
  protected readonly documentStatusesLoading = signal(false);
  protected readonly documentStatusesError = signal('');
  protected readonly transactionDateDisplay = signal(this.formatDateForDisplay(this.today()));
  protected readonly deliveryDateDisplay = signal('');
  protected readonly dueDateDisplay = signal('');
  protected readonly dateInputError = signal('');
  protected readonly paymentTermError = signal('');
  protected readonly itemPriceError = signal('');
  protected readonly itemUomError = signal('');
  protected readonly isExistingOrder = signal(false);
  protected readonly canUpdateOrder = signal(true);
  protected readonly itemRows = this.formBuilder.array<FormGroup>([this.createRow()]);
  protected readonly orderForm = this.formBuilder.group({
    customer: [''],
    date: [this.today()],
    company: [''],
    sellingPriceList: [''],
    billTo: this.formBuilder.group({
      name: [''],
      companyName: [''],
      postalAddress: [''],
      phoneNo: [''],
      faxNo: [''],
      email: [''],
      ntn: [''],
    }),
    shipTo: this.formBuilder.group({
      name: [''],
      companyName: [''],
      postalAddress: [''],
      phoneNo: [''],
      faxNo: [''],
      email: [''],
      ntn: [''],
    }),
    deliveryDate: [''],
    dueDate: [''],
    paymentTerms: [''],
    incoterm: [''],
    items: this.itemRows,
    totalBalanceIncludingTax: [''],
  });

  constructor() {
    this.loadSalesOrderOptions();
    this.route.paramMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((params) => {
      const name = params.get('name') ?? '';
      if (name && name !== this.initializedOrderName) {
        this.initializedOrderName = name;
        this.loadSalesOrder(name);
      } else if (!name && this.initializedOrderName) {
        this.initializedOrderName = '';
        this.resetForNewOrder();
      }
    });

    this.customerSearchRequests.pipe(
      debounceTime(250),
      switchMap((query) => {
        this.customerLoading.set(true);
        this.customerLoadError.set('');
        return this.customerDirectory.searchCustomers(query).pipe(
          catchError((error: unknown) => {
            this.customerLoading.set(false);
            this.customerLoadError.set(this.handleCustomerError(error));
            return of([]);
          }),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((customers) => {
      this.customerOptions.set(customers);
      this.customerLoading.set(false);
    });

    this.customerSearch.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((query) => {
      if (this.customerDropdownOpen() && this.currentUser) {
        this.customerSearchRequests.next(query);
      }
    });

    this.orderForm.controls.customer.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((customerName) => {
      this.loadSelectedCustomer(customerName ?? '');
    });

    this.orderForm.controls.paymentTerms.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.recalculateDueDate());
    this.orderForm.controls.date.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => {
      this.recalculateDueDate();
      this.refreshItemPrices();
    });
    this.orderForm.controls.company.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((companyName) => this.selectPriceListForCompany(companyName ?? ''));

    this.orderForm.controls.sellingPriceList.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => this.refreshItemPrices());
    this.itemRows.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.updateItemTotals();
    });
  }

  protected get currentUser(): string {
    return this.auth.currentUser() ?? '';
  }

  canDeactivate(): boolean {
    if (this.savingOrder()) {
      this.orderError.set('Please wait for the Sales Order save to finish before leaving.');
      return false;
    }
    return !this.orderForm.dirty || window.confirm('You have unsaved changes. Leave this Sales Order?');
  }

  @HostListener('window:beforeunload', ['$event'])
  protected confirmBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.orderForm.dirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  }

  protected loadExistingOrder(event: Event): void {
    const name = (event.target as HTMLSelectElement).value;
    if (name) {
      void this.router.navigate(['/sales-order', name]);
    }
  }

  protected updateDateInput(event: Event, field: 'date' | 'deliveryDate' | 'dueDate'): void {
    const input = event.target as HTMLInputElement;
    const displayValue = input.value.trim();
    this.setDateDisplay(field, displayValue);

    const parsedDate = displayValue ? this.parseDisplayDate(displayValue) : '';
    this.orderForm.controls[field].setValue(parsedDate, { emitEvent: field === 'date' });
    this.orderForm.controls[field].markAsDirty();
    this.updateDateInputError();
  }

  protected updateDeliveryDateFromCalendar(event: Event): void {
    const date = (event.target as HTMLInputElement).value;
    this.orderForm.controls.deliveryDate.setValue(date, { emitEvent: false });
    this.orderForm.controls.deliveryDate.markAsDirty();
    this.deliveryDateDisplay.set(this.formatDateForDisplay(date));
    this.updateDateInputError();
  }

  private formatDateForDisplay(value: string): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    return match ? `${match[2]}-${match[3]}-${match[1]}` : '';
  }

  private parseDisplayDate(value: string): string {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
    if (!match) {
      return '';
    }
    const [, month, day, year] = match;
    const parsed = new Date(Number(year), Number(month) - 1, Number(day));
    if (parsed.getFullYear() !== Number(year)
      || parsed.getMonth() !== Number(month) - 1
      || parsed.getDate() !== Number(day)) {
      return '';
    }
    return `${year}-${month}-${day}`;
  }

  private setDateDisplay(field: 'date' | 'deliveryDate' | 'dueDate', value: string): void {
    if (field === 'date') {
      this.transactionDateDisplay.set(value);
    } else if (field === 'deliveryDate') {
      this.deliveryDateDisplay.set(value);
    } else {
      this.dueDateDisplay.set(value);
    }
  }

  private syncDateDisplays(): void {
    this.transactionDateDisplay.set(this.formatDateForDisplay(this.orderForm.controls.date.value ?? ''));
    this.deliveryDateDisplay.set(this.formatDateForDisplay(this.orderForm.controls.deliveryDate.value ?? ''));
    this.dueDateDisplay.set(this.formatDateForDisplay(this.orderForm.controls.dueDate.value ?? ''));
    this.updateDateInputError();
  }

  private updateDateInputError(): void {
    const invalidInput = [
      this.transactionDateDisplay(),
      this.deliveryDateDisplay(),
      this.dueDateDisplay(),
    ].some((value) => Boolean(value) && !this.parseDisplayDate(value));
    this.dateInputError.set(invalidInput ? 'Enter dates in MM-DD-YYYY format.' : '');
  }

  protected backToSalesOrders(): void {
    void this.router.navigate(['/sales-orders']);
  }

  protected documentStatusBackground(status: string): string {
    const tone = this.documentStatusTone(status);
    return tone === 'green' ? '#e6f3ee'
      : tone === 'yellow' ? '#fff7db'
        : tone === 'red' ? '#fce8e6'
          : '#f3f4f6';
  }

  protected documentStatusBorder(status: string): string {
    const tone = this.documentStatusTone(status);
    return tone === 'green' ? '#b9dccf'
      : tone === 'yellow' ? '#f2d675'
        : tone === 'red' ? '#e6aaa3'
          : '#d1d5db';
  }

  protected documentStatusColor(status: string): string {
    const tone = this.documentStatusTone(status);
    return tone === 'green' ? '#24765f'
      : tone === 'yellow' ? '#785c00'
        : tone === 'red' ? '#a34539'
          : '#5f6b66';
  }

  private documentStatusTone(status: string): 'green' | 'yellow' | 'red' | 'gray' {
    const normalized = status.trim().toLocaleLowerCase();
    if (!normalized || normalized === 'not created' || normalized === 'loading...' || normalized === 'unavailable') {
      return 'gray';
    }
    const values = normalized.split(',').map((value) => value.trim());
    if (values.every((value) => value.includes('cancel'))) {
      return 'red';
    }
    if (normalized.includes('draft') || normalized.includes('partial')) {
      return 'yellow';
    }
    return 'green';
  }

  private refreshDocumentStatuses(order: SalesOrderRecord): void {
    const requestId = ++this.documentStatusRequest;
    const salesOrderStatus = this.salesOrderDocumentStatus(order);
    this.documentStatuses.set({
      salesOrder: salesOrderStatus,
      deliveryNote: 'Loading...',
      salesInvoice: 'Loading...',
    });
    this.documentStatusesLoading.set(true);
    this.documentStatusesError.set('');
    this.salesOrders.getLinkedDocumentStatuses([order.name]).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (statuses) => {
        if (requestId !== this.documentStatusRequest || this.orderName !== order.name) {
          return;
        }
        const linked = statuses[order.name];
        this.documentStatuses.set({
          salesOrder: salesOrderStatus,
          deliveryNote: this.linkedDocumentStatus(linked?.deliveryNoteStatus ?? '—', order, 'delivery'),
          salesInvoice: this.linkedDocumentStatus(linked?.salesInvoiceStatus ?? '—', order, 'invoice'),
        });
        this.documentStatusesLoading.set(false);
      },
      error: (error: unknown) => {
        if (requestId !== this.documentStatusRequest || this.orderName !== order.name) {
          return;
        }
        this.documentStatuses.set({
          salesOrder: salesOrderStatus,
          deliveryNote: 'Unavailable',
          salesInvoice: 'Unavailable',
        });
        this.documentStatusesLoading.set(false);
        this.documentStatusesError.set(`Could not load linked document statuses: ${this.errorMessage(error)}`);
      },
    });
  }

  private salesOrderDocumentStatus(order: SalesOrderRecord): string {
    if (order.docstatus === 2) {
      return 'Cancelled';
    }
    if (order.docstatus === 0) {
      return 'Draft';
    }
    return order.status?.trim() || 'Submitted';
  }

  private linkedDocumentStatus(
    status: string,
    order: SalesOrderRecord,
    kind: 'delivery' | 'invoice',
  ): string {
    if (status === '—') {
      return 'Not Created';
    }
    return this.orderProgressStatus(order, kind) || status;
  }

  private orderProgressStatus(order: SalesOrderRecord, kind: 'delivery' | 'invoice'): string {
    const items = order.items ?? [];
    if (!items.length) {
      return '';
    }
    const completedField = kind === 'delivery' ? 'delivered_qty' : 'billed_amt';
    const completedValues = items.map((item) => item[completedField]);
    if (completedValues.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
      return '';
    }
    const total = items.reduce((sum, item) => {
      const itemTotal = kind === 'delivery'
        ? item.qty
        : item.net_amount ?? item.amount ?? item.qty * item.rate;
      return sum + (Number.isFinite(itemTotal) ? itemTotal : 0);
    }, 0);
    if (total <= 0) {
      return '';
    }
    const completed = completedValues.reduce<number>(
      (sum, value) => sum + (typeof value === 'number' ? value : 0),
      0,
    );
    if (completed >= total - 0.000001) {
      return 'Completed';
    }
    if (completed > 0) {
      return kind === 'delivery' ? 'Partially Delivered' : 'Partially Billed';
    }
    return '';
  }

  protected startNewOrder(): void {
    void this.router.navigate(['/sales-order/new']);
  }

  protected saveOrder(): void {
    this.persistOrder(false);
  }

  protected submitOrder(): void {
    if (!this.isExistingOrder() || !this.canUpdateOrder()) {
      return;
    }
    this.persistOrder(true);
  }

  protected printOrder(): void {
    if (this.orderDocstatus() === 1 && this.orderName) {
      void this.router.navigate(['/sales-order', this.orderName, 'print']);
    }
  }

  private persistOrder(submitAfterSave: boolean): void {
    if (this.savingOrder() || this.optionsLoading()) {
      return;
    }
    if (this.isExistingOrder() && !this.canUpdateOrder()) {
      this.orderError.set('This Sales Order is submitted and cannot be updated. Create a new draft instead.');
      return;
    }

    const customer = this.orderForm.controls.customer.value?.trim() ?? '';
    const company = this.companies().find((option) => option.name === this.orderForm.controls.company.value);
    const priceList = this.priceLists().find((option) => option.name === this.orderForm.controls.sellingPriceList.value);
    const transactionDate = this.orderForm.controls.date.value ?? '';
    if (!customer) {
      this.orderError.set('Customer field is empty. Select a customer before saving.');
      return;
    }
    if (this.dateInputError()) {
      this.orderError.set(this.dateInputError());
      return;
    }
    if (!company) {
      this.orderError.set('The customer company does not match an available company.');
      return;
    }
    if (!priceList) {
      this.orderError.set('The Standard Selling price list is not available for the selected company.');
      return;
    }
    if (!transactionDate) {
      this.orderError.set('Select an order date before saving.');
      return;
    }
    if (!this.namingSeries) {
      this.orderError.set('The Sales Order naming series is not configured.');
      return;
    }

    const items: Array<Record<string, unknown>> = [];
    for (const [index, control] of this.itemRows.controls.entries()) {
      const row = control.getRawValue() as Record<string, unknown>;
      const productName = typeof row['productName'] === 'string' ? row['productName'].trim() : '';
      const quantityValue = row['quantity'];
      const rateValue = row['unitPrice'];
      if (!productName && !String(quantityValue ?? '').trim() && !String(rateValue ?? '').trim()) {
        continue;
      }

      const item = this.orderItems().find((option) =>
        option.item_code.toLocaleLowerCase() === productName.toLocaleLowerCase()
        || option.item_name.toLocaleLowerCase() === productName.toLocaleLowerCase(),
      );
      const qty = Number(quantityValue);
      const rateText = String(rateValue ?? '').trim();
      const rate = Number(rateText);
      const savedItem = this.loadedSalesOrderSnapshot?.items[index];
      if (!item || !Number.isFinite(qty) || qty <= 0
        || !rateText || !Number.isFinite(rate) || rate < 0) {
        this.orderError.set(`Enter a valid product, positive quantity, and non-negative unit price on item row ${index + 1}.`);
        return;
      }

      const unit = typeof row['unit'] === 'string' && row['unit'].trim()
        ? row['unit'].trim()
        : item.stock_uom;
      const lineAmount = this.roundAmount(qty * rate);
      const itemWarehouse = savedItem?.item_code === item.item_code && savedItem.warehouse
        ? savedItem.warehouse
        : company.default_warehouse;
      items.push({
        item_code: item.item_code,
        item_name: item.item_name,
        qty,
        uom: unit,
        stock_uom: item.stock_uom,
        ...(itemWarehouse ? { warehouse: itemWarehouse } : {}),
        rate,
        amount: lineAmount,
      });
    }
    if (!items.length) {
      this.orderError.set('Add at least one valid product row before saving.');
      return;
    }

    this.savingOrder.set(true);
    this.orderError.set('');
    this.orderMessage.set('');
    const savedCurrencySettings = this.loadedCurrencySettings;
    const preserveCurrencySettings = savedCurrencySettings?.company === company.name
      && savedCurrencySettings.selling_price_list === priceList.name;
    const formTotalText = String(this.orderForm.controls.totalBalanceIncludingTax.value ?? '').trim();
    const formTotal = formTotalText ? Number(formTotalText) : undefined;
    if (formTotalText && (!Number.isFinite(formTotal) || Number(formTotal) < 0)) {
      this.orderError.set('Enter a valid Total Balance Including Tax before saving.');
      return;
    }
    const itemsTotal = this.roundAmount(items.reduce((total, item) =>
      total + Number(item['amount'] ?? 0), 0));
    const priceListConversionRate$ = preserveCurrencySettings
      ? of(savedCurrencySettings.plc_conversion_rate)
      : this.salesOrders.getExchangeRate(priceList.currency, company.default_currency, transactionDate);
    priceListConversionRate$.pipe(
      switchMap((priceListConversionRate) => {
        const selectedTerm = this.paymentTerms().find((term) =>
          term.name === this.orderForm.controls.paymentTerms.value,
        );
        const selectedDueDate = this.orderForm.controls.dueDate.value || transactionDate;
        const schedule = selectedTerm
          ? selectedTerm.name === this.loadedPaymentTermName && this.loadedPaymentSchedule.length
            ? this.loadedPaymentSchedule.map((payment, index) => index === 0
              ? {
                ...payment,
                payment_term: selectedTerm.name,
                due_date: selectedDueDate,
                credit_days: selectedTerm.credit_days ?? 0,
                credit_months: selectedTerm.credit_months ?? 0,
              }
              : { ...payment })
            : [{
              payment_term: selectedTerm.name,
              due_date: selectedDueDate,
              invoice_portion: 100,
              credit_days: selectedTerm.credit_days ?? 0,
              credit_months: selectedTerm.credit_months ?? 0,
            }]
          : this.loadedPaymentSchedule.map((payment) => ({ ...payment }));
        const payload: Record<string, unknown> = {
          doctype: 'Sales Order',
          naming_series: this.namingSeries,
          company: company.name,
          set_warehouse: this.loadedSalesOrderSnapshot?.company === company.name
            ? this.loadedSalesOrderSnapshot.set_warehouse || company.default_warehouse || null
            : company.default_warehouse || null,
          customer,
          order_type: 'Sales',
          transaction_date: transactionDate,
          delivery_date: this.orderForm.controls.deliveryDate.value || null,
          currency: preserveCurrencySettings ? savedCurrencySettings.currency : company.default_currency,
          conversion_rate: preserveCurrencySettings ? savedCurrencySettings.conversion_rate : 1,
          selling_price_list: priceList.name,
          price_list_currency: preserveCurrencySettings
            ? savedCurrencySettings.price_list_currency
            : priceList.currency,
          plc_conversion_rate: priceListConversionRate,
          items,
          total: formTotal ?? itemsTotal,
          incoterm: this.orderForm.controls.incoterm.value || null,
          customer_address: this.selectedBillingAddress() || null,
          shipping_address_name: this.selectedShippingAddress() || null,
          contact_mobile: this.orderForm.controls.billTo.controls.phoneNo.value || null,
          contact_email: this.orderForm.controls.billTo.controls.email.value || null,
          payment_schedule: schedule,
        };
        return this.salesOrders.saveSalesOrder(payload, this.orderName || undefined).pipe(
          switchMap((saved) => submitAfterSave
            ? this.salesOrders.submitSalesOrder(saved)
            : of(saved)),
          switchMap((saved) => this.salesOrders.getSalesOrder(saved.name)),
        );
      }),
      finalize(() => this.savingOrder.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (saved) => {
        this.orderName = saved.name;
        this.loadedSalesOrderSnapshot = saved;
        this.currentOrderName.set(saved.name);
        this.orderDocstatus.set(saved.docstatus);
        this.loadedPaymentSchedule = saved.payment_schedule ?? [];
        this.loadedPaymentTermName = this.loadedPaymentSchedule[0]?.payment_term ?? '';
        this.orderTaxes.set(saved.taxes ?? []);
        this.replaceItems(saved.items ?? []);
        this.orderForm.controls.totalBalanceIncludingTax.setValue(String(saved.total ?? ''), { emitEvent: false });
        this.loadedCurrencySettings = {
          company: saved.company,
          selling_price_list: saved.selling_price_list,
          currency: saved.currency,
          conversion_rate: saved.conversion_rate,
          price_list_currency: saved.price_list_currency,
          plc_conversion_rate: saved.plc_conversion_rate,
        };
        this.isExistingOrder.set(true);
        this.canUpdateOrder.set(saved.docstatus === 0);
        if (saved.docstatus === 1) {
          this.orderForm.disable({ emitEvent: false });
        }
        this.orderMessage.set(submitAfterSave
          ? `Sales Order ${saved.name} submitted successfully.`
          : `Sales Order ${saved.name} saved successfully.`);
        this.orderForm.markAsPristine();
        this.updateOrderOption(saved);
        this.refreshDocumentStatuses(saved);
      },
      error: (error: unknown) => this.orderError.set(this.errorMessage(error)),
    });
  }

  private loadSalesOrderOptions(): void {
    this.salesOrders.loadOptions().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (options) => {
        this.companies.set(options.companies);
        this.incoterms.set(mergeUniqueByName(options.incoterms, this.incoterms()));
        this.orderItems.set(options.items);
        this.paymentTerms.set(mergeUniqueByName(options.paymentTerms, this.paymentTerms()));
        this.priceLists.set(options.priceLists.filter((priceList) =>
          priceList.selling === 1 && priceList.enabled === 1,
        ));
        this.salesOrderOptions.set(options.orders);
        const namingSeries = options.salesOrderMetadata.fields.find((field) => field.fieldname === 'naming_series');
        this.namingSeries = namingSeries?.default
          || namingSeries?.options?.split('\n').find((option) => option.trim())
          || '';

        this.selectDefaultCompanyAndPriceList();
        const orderName = this.route.snapshot.paramMap.get('name');
        if (orderName && !this.initializedOrderName) {
          this.loadSalesOrder(orderName);
        } else if (!orderName) {
          this.selectDefaultCompanyAndPriceList();
        }
        this.optionsLoading.set(false);
      },
      error: (error: unknown) => {
        this.optionsLoading.set(false);
        this.orderError.set(`Could not load Sales Order options: ${this.errorMessage(error)}`);
      },
    });
  }

  private loadSalesOrder(name: string): void {
    const requestId = ++this.orderDetailsRequest;
    this.orderName = name;
    this.currentOrderName.set(name);
    this.documentStatusRequest++;
    this.documentStatuses.set({
      salesOrder: 'Loading...',
      deliveryNote: 'Loading...',
      salesInvoice: 'Loading...',
    });
    this.documentStatusesLoading.set(true);
    this.documentStatusesError.set('');
    this.isExistingOrder.set(true);
    this.canUpdateOrder.set(false);
    this.orderForm.disable({ emitEvent: false });
    this.orderLoading.set(true);
    this.orderError.set('');
    this.orderMessage.set('');
    this.paymentTermError.set('');
    this.salesOrders.getSalesOrder(name).pipe(
      finalize(() => {
        if (requestId === this.orderDetailsRequest) {
          this.orderLoading.set(false);
        }
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (order) => {
        if (requestId !== this.orderDetailsRequest) {
          return;
        }
        this.orderName = order.name;
        this.currentOrderName.set(order.name);
        this.orderDocstatus.set(order.docstatus);
        this.refreshDocumentStatuses(order);
        this.loadedPaymentSchedule = order.payment_schedule ?? [];
        this.loadedPaymentTermName = this.loadedPaymentSchedule[0]?.payment_term ?? '';
        this.loadedSalesOrderSnapshot = order;
        this.loadedCurrencySettings = {
          company: order.company,
          selling_price_list: order.selling_price_list,
          currency: order.currency,
          conversion_rate: order.conversion_rate,
          price_list_currency: order.price_list_currency,
          plc_conversion_rate: order.plc_conversion_rate,
        };
        const savedPriceList = order.selling_price_list
          ? {
            name: order.selling_price_list,
            currency: order.price_list_currency,
            selling: 1,
            enabled: 1,
          }
          : null;
        if (savedPriceList) {
          this.priceLists.update((priceLists) => mergeUniqueByName(priceLists, [savedPriceList]));
        }
        const savedItemOptions = (order.items ?? []).map((item) => ({
          item_code: item.item_code,
          item_name: item.item_name || item.item_code,
          stock_uom: item.stock_uom || item.uom || '',
        }));
        this.orderItems.update((items) => [
          ...items,
          ...savedItemOptions.filter((item) => !items.some((option) => option.item_code === item.item_code)),
        ]);
        this.isExistingOrder.set(true);
        this.canUpdateOrder.set(order.docstatus === 0);
        this.orderTaxes.set(order.taxes ?? []);
        this.selectedCustomerLabel.set(order.customer_name || order.customer);
        this.orderForm.patchValue({
          customer: order.customer,
          date: formatDateForInput(order.transaction_date),
          deliveryDate: formatDateForInput(order.delivery_date),
          dueDate: formatDateForInput(order.payment_schedule?.[0]?.due_date),
          incoterm: order.incoterm ?? '',
          company: order.company,
          sellingPriceList: order.selling_price_list,
          paymentTerms: order.payment_schedule?.[0]?.payment_term ?? '',
          totalBalanceIncludingTax: String(order.total ?? ''),
        }, { emitEvent: false });
        this.syncDateDisplays();
        this.selectPriceListForCompany(order.company, order.selling_price_list);
        this.replaceItems(order.items ?? []);
        this.orderForm.markAsPristine();
        if (order.docstatus === 0) {
          this.orderForm.enable({ emitEvent: false });
        } else {
          this.orderForm.disable({ emitEvent: false });
        }
        this.activeCustomerName = '';
        this.loadSelectedCustomer(order.customer);
        const termName = order.payment_schedule?.[0]?.payment_term;
        if (termName && !this.paymentTerms().some((term) => term.name === termName)) {
          this.salesOrders.getPaymentTerm(termName).pipe(
            takeUntilDestroyed(this.destroyRef),
          ).subscribe({
            next: (term) => {
              if (requestId === this.orderDetailsRequest) {
                this.paymentTerms.update((terms) => mergeUniqueByName(terms, [term]));
              }
            },
            error: (error: unknown) => {
              if (requestId === this.orderDetailsRequest) {
                this.paymentTermError.set(this.errorMessage(error));
              }
            },
          });
        }
        const incotermName = order.incoterm;
        if (incotermName && !this.incoterms().some((incoterm) => incoterm.name === incotermName)) {
          this.salesOrders.getIncoterm(incotermName).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
            next: (incoterm) => {
              if (requestId === this.orderDetailsRequest) {
                this.incoterms.update((options) => mergeUniqueByName(options, [incoterm]));
              }
            },
            error: (error: unknown) => {
              if (requestId === this.orderDetailsRequest) {
                this.orderError.set(`Could not load the saved Incoterm: ${this.errorMessage(error)}`);
              }
            },
          });
        }
      },
      error: (error: unknown) => {
        if (requestId === this.orderDetailsRequest) {
          this.documentStatuses.set({
            salesOrder: 'Unavailable',
            deliveryNote: 'Unavailable',
            salesInvoice: 'Unavailable',
          });
          this.documentStatusesLoading.set(false);
          this.documentStatusesError.set(`Could not load document statuses: ${this.errorMessage(error)}`);
          this.orderError.set(`Could not load Sales Order ${name}: ${this.errorMessage(error)}`);
        }
      },
    });
  }

  private resetForNewOrder(): void {
    this.orderDetailsRequest++;
    this.documentStatusRequest++;
    this.documentStatuses.set({
      salesOrder: 'Not Created',
      deliveryNote: 'Not Created',
      salesInvoice: 'Not Created',
    });
    this.documentStatusesLoading.set(false);
    this.documentStatusesError.set('');
    this.orderLoading.set(false);
    this.orderName = '';
    this.currentOrderName.set('');
    this.loadedPaymentSchedule = [];
    this.loadedPaymentTermName = '';
    this.loadedSalesOrderSnapshot = null;
    this.loadedCurrencySettings = null;
    this.orderDocstatus.set(0);
    this.isExistingOrder.set(false);
    this.canUpdateOrder.set(true);
    this.orderForm.enable({ emitEvent: false });
    this.orderTaxes.set([]);
    this.selectedCustomerLabel.set('');
    this.activeCustomerName = '';
    this.customerDetailsRequest++;
    this.customerDetailsLoading.set(false);
    this.customerLoadError.set('');
    this.orderForm.reset({
      customer: '',
      date: this.today(),
      company: '',
      sellingPriceList: '',
      deliveryDate: '',
      dueDate: '',
      paymentTerms: '',
      incoterm: '',
      totalBalanceIncludingTax: '',
      billTo: EMPTY_CUSTOMER_PARTY,
      shipTo: EMPTY_CUSTOMER_PARTY,
    }, { emitEvent: false });
    this.syncDateDisplays();
    this.orderForm.enable({ emitEvent: false });
    this.replaceItems([]);
    this.billingAddressOptions.set([]);
    this.shippingAddressOptions.set([]);
    this.selectedBillingAddress.set('');
    this.selectedShippingAddress.set('');
    this.billingAddressDropdownOpen.set(false);
    this.shippingAddressDropdownOpen.set(false);
    this.customerEmails.set([]);
    this.billingEmailDropdownOpen.set(false);
    this.shippingEmailDropdownOpen.set(false);
    this.paymentTermError.set('');
    this.orderError.set('');
    this.orderMessage.set('');
    this.selectDefaultCompanyAndPriceList();
  }

  private selectDefaultCompanyAndPriceList(): void {
    const partyCompanyName = this.orderForm.controls.billTo.controls.companyName.value?.trim();
    const company = this.companies().find((option) => option.name === partyCompanyName)
      ?? (this.companies().length === 1 ? this.companies()[0] : undefined);
    if (company) {
      this.orderForm.controls.company.setValue(company.name, { emitEvent: false });
      this.selectPriceListForCompany(
        company.name,
        this.orderForm.controls.sellingPriceList.value ?? '',
      );
    }
  }

  private selectPriceListForCompany(companyName: string, preferredPriceList = ''): void {
    const company = this.companies().find((option) => option.name === companyName);
    if (!company) {
      return;
    }
    const matching = this.priceLists().filter((priceList) => priceList.currency === company.default_currency);
    const currentPriceList = this.orderForm.controls.sellingPriceList.value;
    const selected = this.priceLists().find((priceList) => priceList.name === preferredPriceList)
      ?? matching.find((priceList) => priceList.name === currentPriceList)
      ?? matching.find((priceList) => priceList.name.trim().toLocaleLowerCase() === 'standard selling')
      ?? (matching.length === 1 ? matching[0] : undefined);
    this.orderForm.controls.sellingPriceList.setValue(selected?.name ?? '', { emitEvent: false });
    this.refreshItemPrices();
  }

  private handleProductSelection(row: FormGroup, productName: string): void {
    const requestId = (this.itemPriceRequestIds.get(row) ?? 0) + 1;
    this.itemPriceRequestIds.set(row, requestId);
    this.itemUomRequestIds.set(row, (this.itemUomRequestIds.get(row) ?? 0) + 1);
    this.manualPriceEditIds.set(row, (this.manualPriceEditIds.get(row) ?? 0) + 1);
    this.autoUnitPrices.delete(row);
    row.controls['unitPrice'].setValue('', { emitEvent: false });
    row.controls['unit'].setValue('', { emitEvent: false });
    this.itemUomsByRow.set(row, []);
    this.itemPriceError.set('');
    this.itemUomError.set('');
    this.updateItemTotals();
    if (this.orderLoading()) {
      return;
    }

    const normalizedName = productName.trim().toLocaleLowerCase();
    const item = this.orderItems().find((option) =>
      option.item_code.toLocaleLowerCase() === normalizedName
      || option.item_name.toLocaleLowerCase() === normalizedName,
    );
    if (!item) {
      return;
    }

    row.controls['unit'].setValue(item.stock_uom ?? '', { emitEvent: false });
    this.itemUomsByRow.set(row, item.stock_uom ? [item.stock_uom] : []);
    this.loadItemUomOptions(row, item, item.stock_uom ?? '');
    this.requestItemPrice(row, item, true, requestId);
  }

  protected itemUomOptions(row: FormGroup): string[] {
    return this.itemUomsByRow.get(row) ?? [];
  }

  protected handleUnitSelection(row: FormGroup): void {
    if (this.orderLoading()) {
      return;
    }

    const productName = String(row.controls['productName'].value ?? '').trim().toLocaleLowerCase();
    const item = this.orderItems().find((option) =>
      option.item_code.toLocaleLowerCase() === productName
      || option.item_name.toLocaleLowerCase() === productName,
    );
    if (!item) {
      return;
    }

    const requestId = (this.itemPriceRequestIds.get(row) ?? 0) + 1;
    this.itemPriceRequestIds.set(row, requestId);
    this.requestItemPrice(row, item, false, requestId);
  }

  private loadItemUomOptions(row: FormGroup, item: SalesOrderItemOption, selectedUom: string): void {
    const requestId = (this.itemUomRequestIds.get(row) ?? 0) + 1;
    this.itemUomRequestIds.set(row, requestId);
    this.itemUomError.set('');
    this.salesOrders.getItemUoms(item.item_code).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (uoms) => {
        const productName = String(row.controls['productName'].value ?? '').trim().toLocaleLowerCase();
        const matchesItem = productName === item.item_code.toLocaleLowerCase()
          || productName === item.item_name.toLocaleLowerCase();
        if (this.itemUomRequestIds.get(row) !== requestId || !matchesItem) {
          return;
        }
        this.itemUomsByRow.set(row, [...new Set([...uoms, selectedUom].filter(Boolean))]);
      },
      error: (error: unknown) => {
        if (this.itemUomRequestIds.get(row) === requestId) {
          this.itemUomError.set(`Could not load units for ${item.item_code}: ${this.errorMessage(error)}`);
        }
      },
    });
  }

  private refreshItemPrices(): void {
    if (this.orderLoading()) {
      return;
    }
    for (const row of this.itemRows.controls) {
      const productName = String(row.get('productName')?.value ?? '').trim().toLocaleLowerCase();
      const item = this.orderItems().find((option) =>
        option.item_code.toLocaleLowerCase() === productName
        || option.item_name.toLocaleLowerCase() === productName,
      );
      if (!item) {
        continue;
      }
      const requestId = (this.itemPriceRequestIds.get(row) ?? 0) + 1;
      this.itemPriceRequestIds.set(row, requestId);
      this.requestItemPrice(row, item, false, requestId);
    }
  }

  private requestItemPrice(
    row: FormGroup,
    item: SalesOrderItemOption,
    overwriteCurrentPrice: boolean,
    requestId: number,
  ): void {
    const priceList = this.orderForm.controls.sellingPriceList.value ?? '';
    const unitPriceControl = row.controls['unitPrice'];
    const previousAutoPrice = this.autoUnitPrices.get(row);
    const currentPrice = String(unitPriceControl.value ?? '').trim();
    if (previousAutoPrice !== undefined && Number(currentPrice) === previousAutoPrice) {
      unitPriceControl.setValue('', { emitEvent: false });
      this.autoUnitPrices.delete(row);
      this.updateItemTotals();
    } else if (!overwriteCurrentPrice && currentPrice) {
      return;
    }
    if (!priceList) {
      return;
    }

    this.itemPriceError.set('');
    const priceEditId = this.manualPriceEditIds.get(row) ?? 0;
    this.salesOrders.getItemPrices(item.item_code, priceList).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (prices) => {
        if (this.itemPriceRequestIds.get(row) !== requestId
          || this.orderForm.controls.sellingPriceList.value !== priceList
          || this.manualPriceEditIds.get(row) !== priceEditId) {
          return;
        }
        const selectedPrice = this.findValidItemPrice(
          prices.filter((price) =>
            price.item_code === item.item_code
            && price.price_list === priceList
            && price.selling === 1,
          ),
          String(row.controls['unit'].value ?? ''),
          this.orderForm.controls.date.value ?? '',
        );
        if (!selectedPrice) {
          this.itemPriceError.set(
            `No Item Price found for ${item.item_code} in ${priceList}. Enter a unit price manually.`,
          );
          return;
        }
        const currentValue = String(unitPriceControl.value ?? '').trim();
        if (!overwriteCurrentPrice && currentValue) {
          return;
        }
        unitPriceControl.setValue(String(selectedPrice.price_list_rate), { emitEvent: false });
        this.autoUnitPrices.set(row, selectedPrice.price_list_rate);
        this.updateItemTotals();
      },
      error: (error: unknown) => {
        if (this.itemPriceRequestIds.get(row) === requestId) {
          this.itemPriceError.set(
            `Could not fetch the Item Price for ${item.item_code}: ${this.errorMessage(error)} Enter a unit price manually.`,
          );
        }
      },
    });
  }

  private findValidItemPrice(
    prices: ItemPriceOption[],
    unit: string,
    date: string,
  ): ItemPriceOption | undefined {
    const availablePrices = prices.filter((price) =>
      Number.isFinite(price.price_list_rate)
      && price.price_list_rate >= 0
    );
    const matchingUnit = availablePrices.filter((price) => price.uom === unit);
    const defaultUnit = availablePrices.filter((price) => !price.uom);
    const newestPrice = (candidates: ItemPriceOption[]) => candidates
      .sort((left, right) => (right.valid_from ?? '').localeCompare(left.valid_from ?? ''))[0];
    const dateValidPrices = [...matchingUnit, ...defaultUnit].filter((price) =>
      (!price.valid_from || price.valid_from <= date)
      && (!price.valid_upto || price.valid_upto >= date),
    );
    return newestPrice(dateValidPrices) ?? newestPrice([...matchingUnit, ...defaultUnit]);
  }

  private updateItemTotals(): void {
    let totalBalance = 0;
    for (const row of this.itemRows.controls) {
      const quantityValue = String(row.controls['quantity'].value ?? '').trim();
      const unitPriceValue = String(row.controls['unitPrice'].value ?? '').trim();
      const quantity = Number(quantityValue);
      const unitPrice = Number(unitPriceValue);
      if (!quantityValue || !unitPriceValue || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)
        || quantity < 0 || unitPrice < 0) {
        row.controls['total'].setValue('', { emitEvent: false });
        continue;
      }
      const lineTotal = this.roundAmount(quantity * unitPrice);
      row.controls['total'].setValue(String(lineTotal), { emitEvent: false });
      totalBalance += lineTotal;
    }
    this.orderForm.controls.totalBalanceIncludingTax.setValue(
      String(this.roundAmount(totalBalance)),
      { emitEvent: false },
    );
  }

  private roundAmount(amount: number): number {
    return Math.round((amount + Number.EPSILON) * 100) / 100;
  }

  private recalculateDueDate(): void {
    const termName = this.orderForm.controls.paymentTerms.value;
    if (!termName) {
      this.orderForm.controls.dueDate.setValue('', { emitEvent: false });
      this.dueDateDisplay.set('');
      this.paymentTermError.set('');
      return;
    }
    const term = this.paymentTerms().find((option) => option.name === termName);
    if (!term) {
      return;
    }
    const dueDate = calculatePaymentDueDate(this.orderForm.controls.date.value ?? '', term);
    if (dueDate) {
      this.orderForm.controls.dueDate.setValue(dueDate, { emitEvent: false });
      this.dueDateDisplay.set(this.formatDateForDisplay(dueDate));
      this.updateDateInputError();
      this.paymentTermError.set('');
    } else {
      this.paymentTermError.set(`No supported due-date configuration is available for ${term.payment_term_name}.`);
    }
  }

  private replaceItems(items: SalesOrderRecord['items']): void {
    const rowValues = items.length
      ? items.map((item) => ({
        quantity: String(item.qty ?? ''),
        unit: item.uom ?? '',
        productName: item.item_name || item.item_code,
        unitPrice: String(item.rate ?? ''),
        total: String(item.amount ?? item.net_amount ?? (item.qty ?? 0) * (item.rate ?? 0)),
      }))
      : [{ quantity: '', unit: '', productName: '', unitPrice: '', total: '' }];

    for (let index = 0; index < Math.min(this.itemRows.length, rowValues.length); index++) {
      this.itemRows.at(index).patchValue(rowValues[index], { emitEvent: false });
    }
    for (let index = this.itemRows.length; index < rowValues.length; index++) {
      this.itemRows.push(this.createRow(rowValues[index]), { emitEvent: false });
    }
    while (this.itemRows.length > rowValues.length) {
      this.itemRows.removeAt(this.itemRows.length - 1, { emitEvent: false });
    }
    for (const row of this.itemRows.controls) {
      this.itemPriceRequestIds.set(row, (this.itemPriceRequestIds.get(row) ?? 0) + 1);
      this.itemUomRequestIds.set(row, (this.itemUomRequestIds.get(row) ?? 0) + 1);
      this.manualPriceEditIds.set(row, (this.manualPriceEditIds.get(row) ?? 0) + 1);
      this.autoUnitPrices.delete(row);
      const productName = String(row.controls['productName'].value ?? '').trim().toLocaleLowerCase();
      const item = this.orderItems().find((option) =>
        option.item_code.toLocaleLowerCase() === productName
        || option.item_name.toLocaleLowerCase() === productName,
      );
      const selectedUom = String(row.controls['unit'].value ?? '').trim();
      if (item) {
        this.itemUomsByRow.set(row, [...new Set([item.stock_uom, selectedUom].filter(Boolean))]);
        this.loadItemUomOptions(row, item, selectedUom);
      } else {
        this.itemUomsByRow.set(row, []);
      }
    }
  }

  private updateOrderOption(order: SalesOrderRecord): void {
    const option: SalesOrderListOption = {
      name: order.name,
      customer: order.customer,
      customer_name: order.customer_name,
      transaction_date: order.transaction_date,
      delivery_date: order.delivery_date,
      total: order.total,
      grand_total: order.grand_total,
      currency: order.currency,
      status: order.status,
      docstatus: order.docstatus,
    };
    this.salesOrderOptions.update((orders) => [
      option,
      ...orders.filter((existing) => existing.name !== order.name),
    ]);
  }

  private today(): string {
    const date = new Date();
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  }

  protected createRow(initialValues?: {
    quantity: string;
    unit: string;
    productName: string;
    unitPrice: string;
    total: string;
  }): FormGroup {
    const row = initialValues
      ? this.formBuilder.group(initialValues)
      : this.formBuilder.group({
        quantity: [''],
        unit: [''],
        productName: [''],
        unitPrice: [''],
        total: [''],
      });
    row.controls['productName'].valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((productName) => this.handleProductSelection(row, String(productName ?? '')));
    row.controls['unitPrice'].valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => {
      this.manualPriceEditIds.set(row, (this.manualPriceEditIds.get(row) ?? 0) + 1);
      this.autoUnitPrices.delete(row);
      this.itemPriceError.set('');
    });
    return row;
  }

  protected addRow(): void {
    this.itemRows.push(this.createRow());
    this.orderForm.markAsDirty();
  }

  protected toggleCustomerDropdown(): void {
    this.customerDropdownOpen.update((open) => !open);
    if (this.customerDropdownOpen() && this.currentUser) {
      this.customerSearchRequests.next(this.customerSearch.value);
    }
  }

  protected closeCustomerDropdown(): void {
    this.customerDropdownOpen.set(false);
  }

  protected get filteredCustomerOptions(): CustomerOption[] {
    const query = this.customerSearch.value.trim().toLocaleLowerCase();
    if (!query) {
      return this.customerOptions();
    }

    return this.customerOptions().filter((customer) =>
      `${customer.displayName} ${customer.docName}`.toLocaleLowerCase().includes(query),
    );
  }

  protected get filteredPriceLists(): SellingPriceListOption[] {
    const company = this.companies().find((option) => option.name === this.orderForm.controls.company.value);
    if (!company) {
      return [];
    }
    const matching = this.priceLists().filter((priceList) => priceList.currency === company.default_currency);
    const selected = this.priceLists().find((priceList) =>
      priceList.name === this.orderForm.controls.sellingPriceList.value,
    );
    return selected && !matching.some((priceList) => priceList.name === selected.name)
      ? [...matching, selected]
      : matching;
  }

  protected get otherSalesOrderOptions(): SalesOrderListOption[] {
    return this.salesOrderOptions().filter((order) => order.name !== this.currentOrderName());
  }

  protected get currentSalesOrderOption(): SalesOrderListOption | undefined {
    return this.salesOrderOptions().find((order) => order.name === this.currentOrderName());
  }

  protected setCustomerOptions(customers: CustomerOption[]): void {
    this.customerOptions.set(customers);
    this.customerLoadError.set('');
    this.customerLoading.set(false);
  }

  protected selectCustomer(customer: CustomerOption): void {
    this.selectedCustomerLabel.set(customer.displayName);
    this.customerSearch.reset('', { emitEvent: false });
    this.closeCustomerDropdown();
    this.orderForm.controls.customer.setValue(customer.docName);
    this.orderForm.markAsDirty();
  }

  private loadSelectedCustomer(customerName: string): void {
    const docName = customerName.trim();
    const customerChanged = docName !== this.activeCustomerName;
    const requestId = ++this.customerDetailsRequest;

    if (customerChanged) {
      this.activeCustomerName = docName;
      if (this.loadedSalesOrderSnapshot && this.loadedSalesOrderSnapshot.customer !== docName) {
        this.loadedSalesOrderSnapshot = null;
      }
      this.orderForm.controls.billTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
      this.orderForm.controls.shipTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
      this.billingAddressOptions.set([]);
      this.shippingAddressOptions.set([]);
      this.selectedBillingAddress.set('');
      this.selectedShippingAddress.set('');
      this.billingAddressDropdownOpen.set(false);
      this.shippingAddressDropdownOpen.set(false);
      this.customerEmails.set([]);
      this.billingEmailDropdownOpen.set(false);
      this.shippingEmailDropdownOpen.set(false);
      const selectedCustomer = this.customerOptions().find((customer) => customer.docName === docName);
      this.selectedCustomerLabel.set(selectedCustomer?.displayName ?? docName);
    }

    if (!docName) {
      this.customerDetailsLoading.set(false);
      return;
    }

    this.customerDetailsLoading.set(true);
    this.customerLoadError.set('');
    this.customerDirectory.getCustomerDetails(docName)
      .pipe(
        timeout({
          first: 15000,
          with: () => throwError(() => new Error('Loading customer details timed out. Please try again.')),
        }),
        finalize(() => {
          if (requestId === this.customerDetailsRequest) {
            this.customerDetailsLoading.set(false);
          }
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (details) => {
          if (requestId !== this.customerDetailsRequest) {
            return;
          }
          this.billingAddressOptions.set(details.billToAddresses);
          this.shippingAddressOptions.set(details.shipToAddresses);
          this.customerEmails.set(details.emails);
          const selectedCustomer = this.customerOptions().find((customer) => customer.docName === docName);
          const savedOrder = this.loadedSalesOrderSnapshot?.customer === docName
            ? this.loadedSalesOrderSnapshot
            : null;
          const selectedBillingAddress = details.billToAddresses.find((address) =>
            address.docName === savedOrder?.customer_address,
          ) ?? details.billToAddresses[0];
          const selectedShippingAddress = details.shipToAddresses.find((address) =>
            address.docName === savedOrder?.shipping_address_name,
          ) ?? details.shipToAddresses[0];
          this.selectedBillingAddress.set(selectedBillingAddress?.docName ?? '');
          this.selectedShippingAddress.set(selectedShippingAddress?.docName ?? '');
          this.patchPristineParty(this.orderForm.controls.billTo, details.billTo);
          this.patchPristineParty(this.orderForm.controls.shipTo, details.shipTo);
          if (selectedBillingAddress) {
            this.patchPristineParty(this.orderForm.controls.billTo, selectedBillingAddress.details);
          }
          if (selectedShippingAddress) {
            this.patchPristineParty(this.orderForm.controls.shipTo, selectedShippingAddress.details);
          }
          if (savedOrder) {
            this.patchPristineParty(this.orderForm.controls.billTo, {
              name: savedOrder.customer_name || savedOrder.customer,
              phoneNo: savedOrder.contact_mobile || undefined,
              email: savedOrder.contact_email || undefined,
            });
          }
          const customerDisplayName = selectedCustomer?.displayName
            || savedOrder?.customer_name
            || docName;
          this.patchCustomerPartyIdentity(this.orderForm.controls.billTo, customerDisplayName);
          this.patchCustomerPartyIdentity(this.orderForm.controls.shipTo, customerDisplayName);
          if (!savedOrder) {
            this.selectDefaultCompanyAndPriceList();
          }
          this.orderForm.controls.billTo.controls.ntn.setValue(details.taxId, { emitEvent: false });
          this.orderForm.controls.shipTo.controls.ntn.setValue(details.taxId, { emitEvent: false });
        },
        error: (error: unknown) => {
          if (requestId !== this.customerDetailsRequest) {
            return;
          }
          this.customerLoadError.set(this.handleCustomerError(error));
        },
      });
  }

  protected toggleAddressDropdown(party: 'billTo' | 'shipTo'): void {
    const dropdown = party === 'billTo'
      ? this.billingAddressDropdownOpen
      : this.shippingAddressDropdownOpen;
    dropdown.update((open) => !open);
  }

  protected handleAddressTriggerKeydown(party: 'billTo' | 'shipTo', event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    event.preventDefault();
    const dropdown = party === 'billTo'
      ? this.billingAddressDropdownOpen
      : this.shippingAddressDropdownOpen;
    if (dropdown()) {
      event.preventDefault();
      if (event.key === 'ArrowDown') {
        this.focusSelectedAddressOption(party);
      } else {
        dropdown.set(false);
      }
      return;
    }
    dropdown.set(true);
    queueMicrotask(() => this.focusSelectedAddressOption(party));
  }

  protected handleAddressOptionKeydown(party: 'billTo' | 'shipTo', event: KeyboardEvent): void {
    const menuId = party === 'billTo' ? 'bill-address-options' : 'ship-address-options';
    const triggerId = party === 'billTo' ? 'bill-address-trigger' : 'ship-address-trigger';
    const menu = document.getElementById(menuId);
    if (!menu) {
      return;
    }

    const options = [...menu.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const currentIndex = options.indexOf(event.target as HTMLButtonElement);
    let nextIndex: number | undefined;
    if (event.key === 'ArrowDown') {
      nextIndex = (currentIndex + 1) % options.length;
    } else if (event.key === 'ArrowUp') {
      nextIndex = (currentIndex - 1 + options.length) % options.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = options.length - 1;
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.closeAddressDropdown(party);
      document.getElementById(triggerId)?.focus();
      return;
    }

    if (nextIndex !== undefined && options.length) {
      event.preventDefault();
      options[nextIndex].focus();
    }
  }

  @HostListener('document:click', ['$event'])
  protected closeAddressDropdownOnDocumentClick(event: MouseEvent): void {
    const target = event.target;
    if (target instanceof Element && !target.closest('.address-dropdown')) {
      this.billingAddressDropdownOpen.set(false);
      this.shippingAddressDropdownOpen.set(false);
    }
  }

  protected selectBillingAddress(docName: string): void {
    const address = this.billingAddressOptions().find((option) => option.docName === docName);
    if (address) {
      this.selectedBillingAddress.set(address.docName);
      this.orderForm.controls.billTo.patchValue(address.details, { emitEvent: false });
      this.patchCustomerPartyIdentity(this.orderForm.controls.billTo, this.selectedCustomerLabel());
      this.orderForm.markAsDirty();
      this.billingAddressDropdownOpen.set(false);
    }
  }

  protected selectShippingAddress(docName: string): void {
    const address = this.shippingAddressOptions().find((option) => option.docName === docName);
    if (address) {
      this.selectedShippingAddress.set(address.docName);
      this.orderForm.controls.shipTo.patchValue(address.details, { emitEvent: false });
      this.patchCustomerPartyIdentity(this.orderForm.controls.shipTo, this.selectedCustomerLabel());
      this.orderForm.markAsDirty();
      this.shippingAddressDropdownOpen.set(false);
    }
  }

  private closeAddressDropdown(party: 'billTo' | 'shipTo'): void {
    (party === 'billTo' ? this.billingAddressDropdownOpen : this.shippingAddressDropdownOpen).set(false);
  }

  private focusSelectedAddressOption(party: 'billTo' | 'shipTo'): void {
    const menuId = party === 'billTo' ? 'bill-address-options' : 'ship-address-options';
    const selectedId = party === 'billTo'
      ? this.selectedBillingAddress()
      : this.selectedShippingAddress();
    const menu = document.getElementById(menuId);
    const selectedOption = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])]
      .find((option) => option.dataset['addressId'] === selectedId);
    (selectedOption ?? menu?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
  }

  protected toggleEmailDropdown(party: 'billTo' | 'shipTo'): void {
    const dropdown = party === 'billTo' ? this.billingEmailDropdownOpen : this.shippingEmailDropdownOpen;
    dropdown.update((open) => !open);
  }

  protected selectEmail(party: 'billTo' | 'shipTo', email: string): void {
    const group = party === 'billTo' ? this.orderForm.controls.billTo : this.orderForm.controls.shipTo;
    group.controls.email.setValue(email);
    this.orderForm.markAsDirty();
    (party === 'billTo' ? this.billingEmailDropdownOpen : this.shippingEmailDropdownOpen).set(false);
  }

  protected logoutFromFrappe(): void {
    this.auth.logout().pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => {
      this.customerOptions.set([]);
      void this.router.navigate(['/login']);
    });
  }

  protected removeRow(index: number): void {
    if (index > 0 && index < this.itemRows.length) {
      this.itemRows.removeAt(index);
      this.orderForm.markAsDirty();
    }
  }

  private patchPristineParty(group: FormGroup, details: Partial<CustomerOption['billTo']>): void {
    for (const [field, value] of Object.entries(details)) {
      const control = group.get(field);
      if (control?.pristine && typeof value === 'string') {
        control.setValue(value, { emitEvent: false });
      }
    }
  }

  private patchCustomerPartyIdentity(group: FormGroup, customerName: string): void {
    group.patchValue({
      name: customerName,
      companyName: 'Mahhad (Demo)',
    }, { emitEvent: false });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'An unexpected error occurred.';
  }

  private handleCustomerError(error: unknown): string {
    const message = this.errorMessage(error);
    if (message.includes('session has expired') || message.includes('sign-in is required')) {
      this.auth.clearSession();
      this.customerOptions.set([]);
      void this.router.navigate(['/login'], { queryParams: { returnUrl: '/sales-order' } });
    }
    return message;
  }
}
