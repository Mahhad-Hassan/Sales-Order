import { Component, DestroyRef, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormArray, FormBuilder, FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Subject, catchError, debounceTime, of, switchMap } from 'rxjs';
import { CustomerOption, EMPTY_CUSTOMER_PARTY } from './models/customer-option.model';
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

  protected customerDropdownOpen = false;
  protected customerLoading = false;
  protected customerDetailsLoading = false;
  protected customerLoadError = '';
  protected readonly customerSearch = new FormControl('', { nonNullable: true });
  protected customerOptions: CustomerOption[] = [];
  protected selectedCustomerLabel = '';
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
        this.customerLoading = true;
        this.customerLoadError = '';
        return this.customerDirectory.searchCustomers(query).pipe(
          catchError((error: unknown) => {
            this.customerLoading = false;
              this.customerLoadError = this.handleCustomerError(error);
            return of([]);
          }),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe((customers) => {
      this.customerOptions = customers;
      this.customerLoading = false;
    });

    this.customerSearch.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((query) => {
      if (this.customerDropdownOpen && this.currentUser) {
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
    this.customerDropdownOpen = !this.customerDropdownOpen;
    if (this.customerDropdownOpen && this.currentUser) {
      this.customerSearchRequests.next(this.customerSearch.value);
    }
  }

  protected closeCustomerDropdown(): void {
    this.customerDropdownOpen = false;
  }

  protected get filteredCustomerOptions(): CustomerOption[] {
    const query = this.customerSearch.value.trim().toLocaleLowerCase();
    if (!query) {
      return this.customerOptions;
    }

    return this.customerOptions.filter((customer) =>
      `${customer.displayName} ${customer.docName}`.toLocaleLowerCase().includes(query),
    );
  }

  protected setCustomerOptions(customers: CustomerOption[]): void {
    this.customerOptions = customers;
    this.customerLoadError = '';
    this.customerLoading = false;
  }

  protected selectCustomer(customer: CustomerOption): void {
    const customerChanged = this.orderForm.controls.customer.value !== customer.docName;
    const requestId = ++this.customerDetailsRequest;

    if (customerChanged) {
      this.orderForm.controls.billTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
      this.orderForm.controls.shipTo.reset(EMPTY_CUSTOMER_PARTY, { emitEvent: false });
    }

    this.orderForm.controls.customer.setValue(customer.docName);
    this.selectedCustomerLabel = customer.displayName;
    this.customerSearch.reset('', { emitEvent: false });
    this.closeCustomerDropdown();
    this.customerDetailsLoading = true;
    this.customerLoadError = '';

    this.customerDirectory.getCustomerDetails(customer.docName)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (details) => {
          if (requestId !== this.customerDetailsRequest) {
            return;
          }
          this.patchPristineParty(this.orderForm.controls.billTo, details.billTo);
          this.patchPristineParty(this.orderForm.controls.shipTo, details.shipTo);
          this.customerDetailsLoading = false;
        },
        error: (error: unknown) => {
          if (requestId !== this.customerDetailsRequest) {
            return;
          }
          this.customerDetailsLoading = false;
          this.customerLoadError = this.handleCustomerError(error);
        },
      });
  }

  protected logoutFromFrappe(): void {
    this.auth.logout().pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(() => {
      this.customerOptions = [];
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
      this.customerOptions = [];
      void this.router.navigate(['/login'], { queryParams: { returnUrl: '/sales-order' } });
    }
    return message;
  }
}
