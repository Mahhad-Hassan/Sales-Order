import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { EMPTY, catchError, forkJoin, map, switchMap, timer } from 'rxjs';
import { SalesOrderListOption } from './models/sales-order.model';
import { FrappeAuthService } from './services/frappe-auth.service';
import { FrappeSalesOrderService } from './services/frappe-sales-order.service';

@Component({
  imports: [RouterLink],
  selector: 'app-sales-order-list',
  styleUrl: './sales-order-list.scss',
  templateUrl: './sales-order-list.html',
})
export class SalesOrderListPage {
  private readonly salesOrders = inject(FrappeSalesOrderService);
  private readonly auth = inject(FrappeAuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly orders = signal<SalesOrderListOption[]>([]);
  protected readonly searchText = signal('');
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly filteredOrders = computed(() => {
    const query = this.searchText().trim().toLocaleLowerCase();
    if (!query) {
      return this.orders();
    }

    return this.orders().filter((order) => [
      order.name,
      order.customer,
      order.customer_name,
      order.transaction_date,
      order.delivery_date,
      order.salesOrderStatus,
      order.status,
      order.deliveryNoteStatus,
      order.salesInvoiceStatus,
      order.grand_total === undefined ? '' : String(order.grand_total),
    ].some((value) => value?.toLocaleLowerCase().includes(query)));
  });

  constructor() {
    this.loadOrders();
    timer(30_000, 30_000).pipe(
      switchMap(() => {
        const orderNames = this.orders().map((order) => order.name);
        if (!orderNames.length) {
          return EMPTY;
        }
        return forkJoin({
          salesOrders: this.salesOrders.getSalesOrderStatuses(orderNames),
          linkedDocuments: this.salesOrders.getLinkedDocumentStatuses(orderNames),
        }).pipe(
          map(({ salesOrders, linkedDocuments }) => ({
            salesOrders,
            linkedDocuments,
          })),
          catchError((error: unknown) => {
            this.error.set(error instanceof Error
              ? `Could not refresh document workflow statuses: ${error.message}`
              : 'Could not refresh document workflow statuses.');
            return EMPTY;
          }),
        );
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(({ salesOrders, linkedDocuments }) => {
      this.orders.update((orders) => orders.map((order) => ({
        ...order,
        salesOrderStatus: salesOrders[order.name] ?? order.salesOrderStatus,
        deliveryNoteStatus: linkedDocuments[order.name]?.deliveryNoteStatus ?? order.deliveryNoteStatus,
        salesInvoiceStatus: linkedDocuments[order.name]?.salesInvoiceStatus ?? order.salesInvoiceStatus,
      })));
    });
  }

  protected get currentUser(): string {
    return this.auth.currentUser() ?? '';
  }

  protected setSearchText(event: Event): void {
    this.searchText.set((event.target as HTMLInputElement).value);
  }

  protected openOrder(name: string): void {
    void this.router.navigate(['/sales-order', name]);
  }

  protected loadOrders(): void {
    this.loading.set(true);
    this.error.set('');
    this.salesOrders.getAllSalesOrders().pipe(
      switchMap((orders) => this.salesOrders.getLinkedDocumentStatuses(orders.map((order) => order.name)).pipe(
        map((linkedStatuses) => orders.map((order) => ({
          ...order,
          ...linkedStatuses[order.name],
        }))),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (orders) => {
        this.orders.set(orders);
        this.loading.set(false);
      },
      error: (error: unknown) => {
        this.loading.set(false);
        this.error.set(error instanceof Error ? error.message : 'Could not load Sales Orders.');
      },
    });
  }

  protected orderStatus(order: SalesOrderListOption): string {
    if (order.salesOrderStatus) {
      return order.salesOrderStatus;
    }
    if (order.status) {
      return order.status;
    }
    return order.docstatus === 1 ? 'Submitted' : order.docstatus === 2 ? 'Cancelled' : 'Draft';
  }

  protected formatAmount(order: SalesOrderListOption): string {
    const amount = Number(order.grand_total);
    if (!Number.isFinite(amount)) {
      return '—';
    }
    if (order.currency && /^[A-Z]{3}$/.test(order.currency)) {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: order.currency,
      }).format(amount);
    }
    return amount.toLocaleString();
  }

  protected logout(): void {
    this.auth.logout().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => void this.router.navigate(['/login']),
      error: (error: unknown) => {
        this.error.set(error instanceof Error ? error.message : 'Could not sign out.');
      },
    });
  }
}
