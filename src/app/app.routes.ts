import { CanDeactivateFn, Routes } from '@angular/router';
import { App } from './app';
import { frappeAuthGuard } from './guards/frappe-auth.guard';
import { LoginPage } from './login';
import { SalesOrderListPage } from './sales-order-list';
import { SalesOrderPrintPage } from './sales-order-print';

const confirmSalesOrderNavigation: CanDeactivateFn<App> = (component) => component.canDeactivate();

export const appRoutes: Routes = [
  { path: 'login', component: LoginPage },
  { path: 'sales-orders', component: SalesOrderListPage, canActivate: [frappeAuthGuard] },
  { path: 'sales-order/:name/print', component: SalesOrderPrintPage, canActivate: [frappeAuthGuard] },
  { path: 'sales-order/new', component: App, canActivate: [frappeAuthGuard], canDeactivate: [confirmSalesOrderNavigation] },
  { path: 'sales-order/:name', component: App, canActivate: [frappeAuthGuard], canDeactivate: [confirmSalesOrderNavigation] },
  { path: 'sales-order', component: App, canActivate: [frappeAuthGuard], canDeactivate: [confirmSalesOrderNavigation] },
  { path: '', pathMatch: 'full', redirectTo: 'sales-orders' },
  { path: '**', redirectTo: 'sales-orders' },
];