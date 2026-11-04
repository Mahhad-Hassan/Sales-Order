import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, catchError, debounceTime, finalize, of, switchMap, throwError, timeout } from 'rxjs';
import { CustomerAddressOption, CustomerOption, EMPTY_CUSTOMER_PARTY } from './models/customer-option.model';
import { FrappeAuthService } from './services/frappe-auth.service';
import { FrappeCustomerService } from './services/frappe-customer.service';

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
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly customerSearchRequests = new Subject<string>();
  private customerDetailsRequest = 0;

  protected readonly customerDropdownOpen = signal(false);
  protected readonly customerLoading = signal(false);
  protected readonly customerDetailsLoading = signal(false);
  protected readonly customerLoadError = signal('');
  protected readonly customerSearch = new FormControl('', { nonNullable: true });
  protected readonly customerOptions = signal<CustomerOption[]>([]);
  protected readonly selectedCustomerLabel = signal('');
  protected readonly billingAddressOptions = signal<CustomerAddressOption[]>([]);
  protected readonly shippingAddressOptions = signal<CustomerAddressOption[]>([]);
  protected readonly selectedBillingAddress = signal('');
  protected readonly selectedShippingAddress = signal('');
  protected readonly customerEmails = signal<string[]>([]);
  protected readonly billingEmailDropdownOpen = signal(false);
  protected readonly shippingEmailDropdownOpen = signal(false);
  protected readonly itemRows = this.formBuilder.array<FormGroup>([this.createRow()]);
  protected readonly orderForm = this.formBuilder.group({
    customer: [''],
    date: [''],
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
  }

  protected get currentUser(): string {
    return this.auth.currentUser() ?? '';
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

  protected setCustomerOptions(customers: CustomerOption[]): void {
    this.customerOptions.set(customers);
    this.customerLoadError.set('');
    this.customerLoading.set(false);
  }

  protected selectCustomer(customer: CustomerOption): void {
    const customerChanged = this.orderForm.controls.customer.value !== customer.docName;
    const requestId = ++this.customerDetailsRequest;

    if (customerChanged) {
      this.orderForm.controls.billTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
      this.orderForm.controls.shipTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
      this.billingAddressOptions.set([]);
      this.shippingAddressOptions.set([]);
      this.selectedBillingAddress.set('');
      this.selectedShippingAddress.set('');
      this.customerEmails.set([]);
      this.billingEmailDropdownOpen.set(false);
      this.shippingEmailDropdownOpen.set(false);
    }

    this.orderForm.controls.customer.setValue(customer.docName);
    this.selectedCustomerLabel.set(customer.displayName);
    this.customerSearch.reset('', { emitEvent: false });
    this.closeCustomerDropdown();
    this.customerDetailsLoading.set(true);
    this.customerLoadError.set('');

    this.customerDirectory.getCustomerDetails(customer.docName)
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
