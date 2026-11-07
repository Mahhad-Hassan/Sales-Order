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
  private readonly pageSize = 20;
  private readonly salesOrders = inject(FrappeSalesOrderService);
  private readonly auth = inject(FrappeAuthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly orders = signal<SalesOrderListOption[]>([]);
  protected readonly workflowStateStyles = signal<Record<string, string>>({});
  protected readonly searchText = signal('');
  protected readonly currentPage = signal(1);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly filteredOrders = computed(() => {
    const visibleOrders = this.orders().filter((order) => !this.isTerminalOrder(order));
    const query = this.searchText().trim().toLocaleLowerCase();
    if (!query) {
      return visibleOrders;
    }

    return visibleOrders.filter((order) => [
      order.name,
      order.customer,
      order.customer_name,
      order.transaction_date,
      order.delivery_date,
      order.salesOrderStatus,
      order.status,
      order.deliveryNoteStatus,
      order.salesInvoiceStatus,
      order.total === undefined ? '' : String(order.total),
    ].some((value) => value?.toLocaleLowerCase().includes(query)));
  });
  protected readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.filteredOrders().length / this.pageSize)),
  );
  protected readonly paginatedOrders = computed(() => {
    const start = (this.currentPage() - 1) * this.pageSize;
    return this.filteredOrders().slice(start, start + this.pageSize);
  });
  protected readonly firstVisibleRecord = computed(() =>
    this.filteredOrders().length ? (this.currentPage() - 1) * this.pageSize + 1 : 0,
  );
  protected readonly lastVisibleRecord = computed(() =>
    Math.min(this.currentPage() * this.pageSize, this.filteredOrders().length),
  );

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
          workflowStyles: this.salesOrders.getWorkflowStateStyles(),
        }).pipe(
          map(({ salesOrders, linkedDocuments, workflowStyles }) => ({
            salesOrders,
            linkedDocuments,
            workflowStyles,
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
    ).subscribe(({ salesOrders, linkedDocuments, workflowStyles }) => {
      this.orders.update((orders) => orders.map((order) => ({
        ...order,
        salesOrderStatus: salesOrders[order.name] ?? order.salesOrderStatus,
        deliveryNoteStatus: linkedDocuments[order.name]?.deliveryNoteStatus ?? order.deliveryNoteStatus,
        salesInvoiceStatus: linkedDocuments[order.name]?.salesInvoiceStatus ?? order.salesInvoiceStatus,
      })));
      this.workflowStateStyles.set(workflowStyles);
    });
  }

  protected get currentUser(): string {
    return this.auth.currentUser() ?? '';
  }

  protected setSearchText(event: Event): void {
    this.searchText.set((event.target as HTMLInputElement).value);
    this.currentPage.set(1);
  }

  protected goToPreviousPage(): void {
    this.currentPage.update((page) => Math.max(1, page - 1));
  }

  protected goToNextPage(): void {
    this.currentPage.update((page) => Math.min(this.pageCount(), page + 1));
  }

  protected openOrder(name: string): void {
    void this.router.navigate(['/sales-order', name]);
  }

  protected loadOrders(): void {
    this.loading.set(true);
    this.error.set('');
    this.salesOrders.getAllSalesOrders().pipe(
      switchMap((orders) => forkJoin({
        linkedStatuses: this.salesOrders.getLinkedDocumentStatuses(orders.map((order) => order.name)),
        workflowStyles: this.salesOrders.getWorkflowStateStyles(),
      }).pipe(
        map(({ linkedStatuses, workflowStyles }) => ({
          orders: orders.map((order) => ({
            ...order,
            ...linkedStatuses[order.name],
          })),
          workflowStyles,
        })),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: ({ orders, workflowStyles }) => {
        this.orders.set(orders);
        this.currentPage.update((page) => Math.min(page, Math.max(1, Math.ceil(orders.length / this.pageSize))));
        this.workflowStateStyles.set(workflowStyles);
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

  private isTerminalOrder(order: SalesOrderListOption): boolean {
    const status = this.orderStatus(order).trim().toLocaleLowerCase();
    return ['approved', 'rejected', 'cancelled'].includes(status);
  }

  protected statusValues(status: string | undefined): string[] {
    return status?.split(',').map((value) => value.trim()).filter(Boolean) ?? [];
  }

  protected statusStyleClass(status: string): string {
    const statusName = status.replace(/\s+\(\d+\)$/, '');
    switch ((this.workflowStateStyles()[statusName] ?? '').toLocaleLowerCase()) {
      case 'success':
        return 'workflow-status-success';
      case 'danger':
        return 'workflow-status-danger';
      case 'inverse':
        return 'workflow-status-inverse';
      case 'primary':
        return 'workflow-status-primary';
      case 'info':
        return 'workflow-status-info';
      case 'warning':
        return 'workflow-status-warning';
      default:
        return 'workflow-status-default';
    }
  }

  protected formatAmount(order: SalesOrderListOption): string {
    const amount = Number(order.total);
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
