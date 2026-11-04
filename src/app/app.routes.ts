import { Routes } from '@angular/router';
import { App } from './app';
import { frappeAuthGuard } from './guards/frappe-auth.guard';
import { LoginPage } from './login';

export const appRoutes: Routes = [
  { path: 'login', component: LoginPage },
  { path: 'sales-order', component: App, canActivate: [frappeAuthGuard] },
  { path: '', pathMatch: 'full', redirectTo: 'sales-order' },
  { path: '**', redirectTo: 'sales-order' },
];