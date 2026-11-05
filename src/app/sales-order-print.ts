import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { CustomerOption, CustomerPartyDetails } from './models/customer-option.model';
import { IncotermOption, PaymentTermOption, SalesOrderRecord } from './models/sales-order.model';
import { FrappeCustomerService } from './services/frappe-customer.service';
import { FrappeSalesOrderService } from './services/frappe-sales-order.service';

@Component({
  imports: [RouterLink],
  selector: 'app-sales-order-print',
  styleUrl: './sales-order-print.scss',
  templateUrl: './sales-order-print.html',
})
export class SalesOrderPrintPage {
  private readonly route = inject(ActivatedRoute);
  private readonly salesOrders = inject(FrappeSalesOrderService);
  private readonly customers = inject(FrappeCustomerService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly order = signal<SalesOrderRecord | null>(null);
  protected readonly customer = signal<CustomerOption | null>(null);
  protected readonly paymentTerm = signal<PaymentTermOption | null>(null);
  protected readonly incoterm = signal<IncotermOption | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly customerDetailsError = signal('');

  constructor() {
    const name = this.route.snapshot.paramMap.get('name');
    if (!name) {
      this.loading.set(false);
      this.error.set('A Sales Order ID is required to print.');
      return;
    }

    this.salesOrders.getSalesOrder(name).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (order) => {
        this.loading.set(false);
        if (order.docstatus !== 1) {
          this.error.set('Only submitted Sales Orders can be printed.');
          return;
        }
        this.order.set(order);
        this.loadCustomerDetails(order.customer);
        const paymentTermName = order.payment_schedule?.[0]?.payment_term;
        if (paymentTermName) {
          this.salesOrders.getPaymentTerm(paymentTermName).pipe(
            takeUntilDestroyed(this.destroyRef),
          ).subscribe({
            next: (term) => this.paymentTerm.set(term),
            error: (error: unknown) => this.customerDetailsError.update((current) =>
              [current, `Could not load Payment Term: ${this.errorMessage(error)}`].filter(Boolean).join(' '),
            ),
          });
        }
        if (order.incoterm) {
          this.salesOrders.getIncoterm(order.incoterm).pipe(
            takeUntilDestroyed(this.destroyRef),
          ).subscribe({
            next: (incoterm) => this.incoterm.set(incoterm),
            error: (error: unknown) => this.customerDetailsError.update((current) =>
              [current, `Could not load Incoterm: ${this.errorMessage(error)}`].filter(Boolean).join(' '),
            ),
          });
        }
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(error instanceof Error ? error.message : 'Could not load the Sales Order for printing.');
      },
    });
  }

  protected print(): void {
    if (this.order()?.docstatus === 1) {
      window.print();
    }
  }

  protected amount(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) {
      return '—';
    }
    const currency = this.order()?.currency;
    if (currency && /^[A-Z]{3}$/.test(currency)) {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(Number(value));
    }
    return Number(value).toLocaleString();
  }

  protected billingParty(): Partial<CustomerPartyDetails> | undefined {
    const order = this.order();
    const customer = this.customer();
    if (!order || !customer) {
      return customer?.billTo;
    }
    return customer.billToAddresses.find((address) => address.docName === order.customer_address)?.details
      ?? customer.billTo;
  }

  protected shippingParty(): Partial<CustomerPartyDetails> | undefined {
    const order = this.order();
    const customer = this.customer();
    if (!order || !customer) {
      return customer?.shipTo;
    }
    return customer.shipToAddresses.find((address) => address.docName === order.shipping_address_name)?.details
      ?? customer.shipTo;
  }

  protected billingAddress(): string {
    return this.billingParty()?.postalAddress || this.order()?.address_display || this.order()?.customer_address || '';
  }

  protected shippingAddress(): string {
    return this.shippingParty()?.postalAddress || this.order()?.shipping_address || '';
  }

  protected totalBalance(): number {
    return (this.order()?.items ?? []).reduce((total, item) =>
      total + Number(item.qty || 0) * Number(item.rate || 0), 0);
  }

  protected displayDate(value: string | null | undefined): string {
    if (!value) {
      return '—';
    }
    const [year, month, day] = value.slice(0, 10).split('-');
    return year && month && day ? `${month}/${day}/${year}` : value;
  }

  protected paymentTermName(): string {
    return this.paymentTerm()?.payment_term_name
      || this.order()?.payment_terms_template
      || this.order()?.payment_schedule?.[0]?.payment_term
      || '—';
  }

  protected incotermTitle(): string {
    return this.incoterm()?.title || this.order()?.incoterm || '—';
  }

  private loadCustomerDetails(customerName: string): void {
    this.customers.getCustomerDetails(customerName).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (customer) => this.customer.set(customer),
      error: (error: unknown) => {
        this.customerDetailsError.set(
          `Could not load the latest customer contact details: ${this.errorMessage(error)}`,
        );
      },
    });
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Unexpected Frappe error.';
  }
}
