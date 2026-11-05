import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { SalesOrderListOption } from './models/sales-order.model';
import { FrappeAuthService } from './services/frappe-auth.service';
import { FrappeSalesOrderService } from './services/frappe-sales-order.service';

@Component({
  imports: [RouterLink],
  selector: 'app-sales-order-list',
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
      order.status,
    ].some((value) => value?.toLocaleLowerCase().includes(query)));
  });

  constructor() {
    this.loadOrders();
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
    this.salesOrders.getAllSalesOrders().pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
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
