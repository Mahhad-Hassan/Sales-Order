import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { Subject, catchError, debounceTime, finalize, forkJoin, of, switchMap, throwError, timeout } from 'rxjs';
import { CustomerAddressOption, CustomerOption, EMPTY_CUSTOMER_PARTY } from './models/customer-option.model';
import { calculatePaymentDueDate, formatDateForInput } from './models/payment-term-date';
import {
  CompanyOption,
  IncotermOption,
  PaymentTermOption,
  SalesOrderItemOption,
  SalesOrderListOption,
  SalesOrderRecord,
  SellingPriceListOption,
} from './models/sales-order.model';
import { FrappeAuthService } from './services/frappe-auth.service';
import { FrappeCustomerService } from './services/frappe-customer.service';
import { FrappeSalesOrderService } from './services/frappe-sales-order.service';

@Component({
  imports: [ReactiveFormsModule],
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
  private activeCustomerName = '';
  private orderName = '';
  private orderDocstatus = 0;
  private namingSeries = '';
  private initializedOrderName = '';
  private loadedPaymentSchedule: NonNullable<SalesOrderRecord['payment_schedule']> = [];
  private loadedPaymentTermName = '';
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
  protected readonly customerEmails = signal<string[]>([]);
  protected readonly billingEmailDropdownOpen = signal(false);
  protected readonly shippingEmailDropdownOpen = signal(false);
  protected readonly companies = signal<CompanyOption[]>([]);
  protected readonly priceLists = signal<SellingPriceListOption[]>([]);
  protected readonly incoterms = signal<IncotermOption[]>([]);
  protected readonly paymentTerms = signal<PaymentTermOption[]>([]);
  protected readonly salesOrderOptions = signal<SalesOrderListOption[]>([]);
  protected readonly orderItems = signal<SalesOrderItemOption[]>([]);
  protected readonly optionsLoading = signal(true);
  protected readonly orderLoading = signal(false);
  protected readonly savingOrder = signal(false);
  protected readonly orderError = signal('');
  protected readonly orderMessage = signal('');
  protected readonly paymentTermError = signal('');
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
    ).subscribe(() => this.recalculateDueDate());
    this.orderForm.controls.company.valueChanges.pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((companyName) => this.selectPriceListForCompany(companyName ?? ''));
  }

  protected get currentUser(): string {
    return this.auth.currentUser() ?? '';
  }

  protected loadExistingOrder(event: Event): void {
    const name = (event.target as HTMLSelectElement).value;
    if (name) {
      void this.router.navigate(['/sales-order', name]);
    }
  }

  protected startNewOrder(): void {
    void this.router.navigate(['/sales-order']);
  }

  protected saveOrder(): void {
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
    if (!customer || !company || !priceList || !transactionDate) {
      this.orderError.set('Select a customer, company, selling price list, and order date before saving.');
      return;
    }
    if (!this.namingSeries) {
      this.orderError.set('The Sales Order naming series is not configured in Frappe.');
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
      const hasRate = typeof rateValue === 'string' && rateValue.trim().length > 0;
      const rate = hasRate ? Number(rateValue) : undefined;
      if (!item || !Number.isFinite(qty) || qty <= 0
        || (hasRate && (!Number.isFinite(rate) || Number(rate) < 0))) {
        this.orderError.set(`Enter a valid product, positive quantity, and non-negative unit price on item row ${index + 1}.`);
        return;
      }

      const unit = typeof row['unit'] === 'string' && row['unit'].trim()
        ? row['unit'].trim()
        : item.stock_uom;
      items.push({
        item_code: item.item_code,
        item_name: item.item_name,
        qty,
        uom: unit,
        stock_uom: item.stock_uom,
        ...(rate === undefined ? {} : { rate }),
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
          incoterm: this.orderForm.controls.incoterm.value || null,
          payment_schedule: schedule,
        };
        return this.salesOrders.saveSalesOrder(payload, this.orderName || undefined);
      }),
      finalize(() => this.savingOrder.set(false)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (saved) => {
        this.orderName = saved.name;
        this.currentOrderName.set(saved.name);
        this.orderDocstatus = saved.docstatus;
        this.loadedPaymentSchedule = saved.payment_schedule ?? [];
        this.loadedPaymentTermName = this.loadedPaymentSchedule[0]?.payment_term ?? '';
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
        this.orderMessage.set(`Sales Order ${saved.name} saved successfully.`);
        this.updateOrderOption(saved);
        if (this.route.snapshot.paramMap.get('name') !== saved.name) {
          void this.router.navigate(['/sales-order', saved.name]);
        }
      },
      error: (error: unknown) => this.orderError.set(this.errorMessage(error)),
    });
  }

  private loadSalesOrderOptions(): void {
    this.salesOrders.loadOptions().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (options) => {
        this.companies.set(options.companies);
        const previouslyLoadedIncoterms = this.incoterms();
        this.incoterms.set([
          ...options.incoterms,
          ...previouslyLoadedIncoterms.filter((incoterm) =>
            !options.incoterms.some((option) => option.name === incoterm.name),
          ),
        ]);
        this.orderItems.set(options.items);
        const previouslyLoadedPaymentTerms = this.paymentTerms();
        this.paymentTerms.set([
          ...options.paymentTerms,
          ...previouslyLoadedPaymentTerms.filter((term) =>
            !options.paymentTerms.some((option) => option.name === term.name),
          ),
        ]);
        this.priceLists.set(options.priceLists.filter((priceList) =>
          priceList.selling === 1 && priceList.enabled === 1,
        ));
        this.salesOrderOptions.set(options.orders);
        const namingSeries = options.salesOrderMetadata.fields.find((field) => field.fieldname === 'naming_series');
        this.namingSeries = namingSeries?.default
          || namingSeries?.options?.split('\n').find((option) => option.trim())
          || '';

        const matchingCompanies = this.companies();
        if (matchingCompanies.length === 1) {
          this.orderForm.controls.company.setValue(matchingCompanies[0].name, { emitEvent: false });
        }
        this.selectPriceListForCompany(
          this.orderForm.controls.company.value ?? '',
          this.orderForm.controls.sellingPriceList.value ?? '',
        );
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
    this.isExistingOrder.set(true);
    this.canUpdateOrder.set(false);
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
        this.orderDocstatus = order.docstatus;
        this.loadedPaymentSchedule = order.payment_schedule ?? [];
        this.loadedPaymentTermName = this.loadedPaymentSchedule[0]?.payment_term ?? '';
        this.loadedCurrencySettings = {
          company: order.company,
          selling_price_list: order.selling_price_list,
          currency: order.currency,
          conversion_rate: order.conversion_rate,
          price_list_currency: order.price_list_currency,
          plc_conversion_rate: order.plc_conversion_rate,
        };
        this.isExistingOrder.set(true);
        this.canUpdateOrder.set(order.docstatus === 0);
        this.selectedCustomerLabel.set(order.customer);
        this.orderForm.patchValue({
          customer: order.customer,
          date: formatDateForInput(order.transaction_date),
          deliveryDate: formatDateForInput(order.delivery_date),
          dueDate: formatDateForInput(order.payment_schedule?.[0]?.due_date),
          incoterm: order.incoterm ?? '',
          company: order.company,
          sellingPriceList: order.selling_price_list,
          paymentTerms: order.payment_schedule?.[0]?.payment_term ?? '',
        }, { emitEvent: false });
        this.selectPriceListForCompany(order.company, order.selling_price_list);
        this.replaceItems(order.items ?? []);
        this.activeCustomerName = '';
        this.loadSelectedCustomer(order.customer);
        const termName = order.payment_schedule?.[0]?.payment_term;
        if (termName && !this.paymentTerms().some((term) => term.name === termName)) {
          this.salesOrders.getPaymentTerm(termName).pipe(
            takeUntilDestroyed(this.destroyRef),
          ).subscribe({
            next: (term) => {
              if (requestId === this.orderDetailsRequest) {
                this.paymentTerms.update((terms) => [...terms, term]);
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
                this.incoterms.update((options) => [...options, incoterm]);
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
          this.orderError.set(`Could not load Sales Order ${name}: ${this.errorMessage(error)}`);
        }
      },
    });
  }

  private resetForNewOrder(): void {
    this.orderDetailsRequest++;
    this.orderLoading.set(false);
    this.orderName = '';
    this.currentOrderName.set('');
    this.loadedPaymentSchedule = [];
    this.loadedPaymentTermName = '';
    this.loadedCurrencySettings = null;
    this.orderDocstatus = 0;
    this.isExistingOrder.set(false);
    this.canUpdateOrder.set(true);
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
    this.replaceItems([]);
    this.billingAddressOptions.set([]);
    this.shippingAddressOptions.set([]);
    this.selectedBillingAddress.set('');
    this.selectedShippingAddress.set('');
    this.customerEmails.set([]);
    this.billingEmailDropdownOpen.set(false);
    this.shippingEmailDropdownOpen.set(false);
    this.paymentTermError.set('');
    this.orderError.set('');
    this.orderMessage.set('');
    this.selectDefaultCompanyAndPriceList();
  }

  private selectDefaultCompanyAndPriceList(): void {
    if (this.companies().length === 1) {
      const company = this.companies()[0];
      this.orderForm.controls.company.setValue(company.name, { emitEvent: false });
      this.selectPriceListForCompany(company.name);
    }
  }

  private selectPriceListForCompany(companyName: string, preferredPriceList = ''): void {
    const company = this.companies().find((option) => option.name === companyName);
    if (!company) {
      return;
    }
    const matching = this.priceLists().filter((priceList) => priceList.currency === company.default_currency);
    const currentPriceList = this.orderForm.controls.sellingPriceList.value;
    const selected = matching.find((priceList) => priceList.name === preferredPriceList)
      ?? matching.find((priceList) => priceList.name === currentPriceList)
      ?? (matching.length === 1 ? matching[0] : undefined);
    this.orderForm.controls.sellingPriceList.setValue(selected?.name ?? '', { emitEvent: false });
  }

  private recalculateDueDate(): void {
    const termName = this.orderForm.controls.paymentTerms.value;
    if (!termName) {
      this.orderForm.controls.dueDate.setValue('', { emitEvent: false });
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
      this.paymentTermError.set('');
    } else {
      this.paymentTermError.set(`Frappe has no supported due-date configuration for ${term.payment_term_name}.`);
    }
  }

  private replaceItems(items: SalesOrderRecord['items']): void {
    this.itemRows.clear({ emitEvent: false });
    if (!items.length) {
      this.itemRows.push(this.createRow(), { emitEvent: false });
      return;
    }
    for (const item of items) {
      this.itemRows.push(this.formBuilder.group({
        quantity: [String(item.qty ?? '')],
        unit: [item.uom ?? ''],
        productName: [item.item_name || item.item_code],
        unitPrice: [String(item.rate ?? '')],
        total: [String((item.qty ?? 0) * (item.rate ?? 0))],
      }), { emitEvent: false });
    }
  }

  private updateOrderOption(order: SalesOrderRecord): void {
    const option: SalesOrderListOption = {
      name: order.name,
      customer: order.customer,
      transaction_date: order.transaction_date,
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

  protected createRow(): FormGroup {
    return this.formBuilder.group({
      quantity: [''],
      unit: [''],
      productName: [''],
      unitPrice: [''],
      total: [''],
    });
  }

  protected addRow(): void {
    this.itemRows.push(this.createRow());
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
    return company
      ? this.priceLists().filter((priceList) => priceList.currency === company.default_currency)
      : [];
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
  }

  private loadSelectedCustomer(customerName: string): void {
    const docName = customerName.trim();
    const customerChanged = docName !== this.activeCustomerName;
    const requestId = ++this.customerDetailsRequest;

    if (customerChanged) {
      this.activeCustomerName = docName;
      this.orderForm.controls.billTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
      this.orderForm.controls.shipTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
      this.billingAddressOptions.set([]);
      this.shippingAddressOptions.set([]);
      this.selectedBillingAddress.set('');
      this.selectedShippingAddress.set('');
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
          this.selectedBillingAddress.set(details.billToAddresses[0]?.docName ?? '');
          this.selectedShippingAddress.set(details.shipToAddresses[0]?.docName ?? '');
          this.patchPristineParty(this.orderForm.controls.billTo, details.billTo);
          this.patchPristineParty(this.orderForm.controls.shipTo, details.shipTo);
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

  protected selectBillingAddress(event: Event): void {
    const docName = (event.target as HTMLSelectElement).value;
    const address = this.billingAddressOptions().find((option) => option.docName === docName);
    if (address) {
      this.selectedBillingAddress.set(address.docName);
      this.orderForm.controls.billTo.patchValue(address.details, { emitEvent: false });
    }
  }

  protected selectShippingAddress(event: Event): void {
    const docName = (event.target as HTMLSelectElement).value;
    const address = this.shippingAddressOptions().find((option) => option.docName === docName);
    if (address) {
      this.selectedShippingAddress.set(address.docName);
      this.orderForm.controls.shipTo.patchValue(address.details, { emitEvent: false });
    }
  }

  protected toggleEmailDropdown(party: 'billTo' | 'shipTo'): void {
    const dropdown = party === 'billTo' ? this.billingEmailDropdownOpen : this.shippingEmailDropdownOpen;
    dropdown.update((open) => !open);
  }

  protected selectEmail(party: 'billTo' | 'shipTo', email: string): void {
    const group = party === 'billTo' ? this.orderForm.controls.billTo : this.orderForm.controls.shipTo;
    group.controls.email.setValue(email);
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

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'An unexpected Frappe error occurred.';
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
