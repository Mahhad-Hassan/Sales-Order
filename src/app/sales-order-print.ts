import { Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { SalesOrderRecord } from './models/sales-order.model';
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
  private readonly destroyRef = inject(DestroyRef);

  protected readonly order = signal<SalesOrderRecord | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');

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
}
