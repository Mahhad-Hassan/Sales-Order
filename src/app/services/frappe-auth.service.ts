import { Injectable, inject, signal } from '@angular/core';
import { Observable, catchError, map, of, switchMap, tap } from 'rxjs';
import { FrappeApiService } from './frappe-api.service';

@Injectable({ providedIn: 'root' })
export class FrappeAuthService {
  private readonly api = inject(FrappeApiService);

  readonly currentUser = signal<string | null>(null);

  checkSession(): Observable<boolean> {
    return this.api.getLoggedUser().pipe(
      tap((user) => this.currentUser.set(user)),
      map(() => true),
      catchError(() => {
        this.clearSession();
        return of(false);
      }),
    );
  }

  login(username: string, password: string): Observable<string> {
    return this.api.login(username, password).pipe(
      switchMap(() => this.api.getLoggedUser()),
      tap((user) => this.currentUser.set(user)),
    );
  }

  logout(): Observable<void> {
    return this.api.logout().pipe(
      map(() => undefined),
      catchError(() => of(undefined)),
      tap(() => this.clearSession()),
    );
  }

  clearSession(): void {
    this.currentUser.set(null);
  }
}