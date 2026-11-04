import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import { FrappeAuthService } from '../services/frappe-auth.service';

export const frappeAuthInterceptor: HttpInterceptorFn = (request, next) => {
  const auth = inject(FrappeAuthService);
  const router = inject(Router);

  return next(request).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse
        && error.status === 401
        && !request.url.endsWith('/api/method/login')
      ) {
        auth.clearSession();
        if (!request.url.includes('frappe.auth.get_logged_user') && !router.url.startsWith('/login')) {
          void router.navigate(['/login'], { queryParams: { returnUrl: router.url } });
        }
      }

      return throwError(() => error);
    }),
  );
};