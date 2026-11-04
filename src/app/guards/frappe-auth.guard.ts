import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { map } from 'rxjs';
import { FrappeAuthService } from '../services/frappe-auth.service';

export const frappeAuthGuard: CanActivateFn = (_route, state) => {
  const auth = inject(FrappeAuthService);
  const router = inject(Router);

  return auth.checkSession().pipe(
    map((authenticated) => authenticated
      ? true
      : router.createUrlTree(['/login'], { queryParams: { returnUrl: state.url } }),
    ),
  );
};