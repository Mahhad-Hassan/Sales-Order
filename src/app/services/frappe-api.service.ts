import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, catchError, defer, map, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import {
  FrappeDataResponse,
  FrappeListResponse,
  FrappeLoginResponse,
  FrappeMethodResponse,
  FrappeMessageResponse,
} from '../models/frappe-api.model';

@Injectable({ providedIn: 'root' })
export class FrappeApiService {
  private readonly http = inject(HttpClient);

  login(username: string, password: string): Observable<FrappeLoginResponse> {
    return this.request(() =>
      this.http.post<FrappeLoginResponse>(
        this.methodUrl('login'),
        { usr: username, pwd: password },
        { withCredentials: true },
      ),
    );
  }

  logout(): Observable<FrappeMessageResponse> {
    return this.request(() =>
      this.http.post<FrappeMessageResponse>(this.methodUrl('logout'), {}, { withCredentials: true }),
    );
  }

  getLoggedUser(): Observable<string> {
    return this.request(() =>
      this.http
        .get<FrappeMessageResponse>(this.methodUrl('frappe.auth.get_logged_user'), {
          withCredentials: true,
        })
        .pipe(map((response) => response.message)),
    );
  }

  getList<T>(
    doctype: string,
    fields: string[],
    filters: unknown[][] = [],
    limitPageLength = 20,
    limitStart = 0,
  ): Observable<T[]> {
    let params = new HttpParams()
      .set('fields', JSON.stringify(fields))
      .set('limit_page_length', String(limitPageLength))
      .set('limit_start', String(limitStart));

    if (filters.length) {
      params = params.set('filters', JSON.stringify(filters));
    }

    return this.request(() =>
      this.http
        .get<FrappeListResponse<T>>(this.resourceUrl(doctype), {
          params,
          withCredentials: true,
        })
        .pipe(map((response) => response.data)),
    );
  }

  getDocument<T>(doctype: string, name: string): Observable<T> {
    return this.request(() =>
      this.http
        .get<FrappeDataResponse<T>>(this.resourceUrl(doctype, name), { withCredentials: true })
        .pipe(map((response) => response.data)),
    );
  }

  createDocument<T>(doctype: string, document: Record<string, unknown>): Observable<T> {
    return this.request(() =>
      this.http
        .post<FrappeDataResponse<T>>(this.resourceUrl(doctype), document, { withCredentials: true })
        .pipe(map((response) => response.data)),
    );
  }

  updateDocument<T>(
    doctype: string,
    name: string,
    changes: Record<string, unknown>,
  ): Observable<T> {
    return this.request(() =>
      this.http
        .put<FrappeDataResponse<T>>(this.resourceUrl(doctype, name), changes, {
          withCredentials: true,
        })
        .pipe(map((response) => response.data)),
    );
  }

  callMethod<T>(method: string, args: Record<string, unknown>): Observable<T> {
    return this.request(() =>
      this.http
        .post<FrappeMethodResponse<T>>(this.methodUrl(method), args, { withCredentials: true })
        .pipe(map((response) => response.message)),
    );
  }

  private methodUrl(method: string): string {
    return `${this.baseUrl}/api/method/${method}`;
  }

  private resourceUrl(doctype: string, name?: string): string {
    const resource = encodeURIComponent(doctype);
    const document = name ? `/${encodeURIComponent(name)}` : '';
    return `${this.baseUrl}/api/resource/${resource}${document}`;
  }

  private get baseUrl(): string {
    const baseUrl = environment.frappeBaseUrl.trim().replace(/\/+$/, '');
    if (!baseUrl && !environment.production) {
      return '';
    }

    const isHttps = baseUrl.startsWith('https://');
    const isDevelopmentHttp = !environment.production && baseUrl.startsWith('http://');
    const isProductionProxy = environment.production && baseUrl === '/api/frappe-proxy';

    if (!isHttps && !isDevelopmentHttp && !isProductionProxy) {
      throw new Error(environment.production
        ? 'Configure a reachable HTTPS Frappe URL before connecting.'
        : 'Configure an HTTP or HTTPS Frappe URL before connecting.');
    }

    return baseUrl;
  }

  private request<T>(request: () => Observable<T>): Observable<T> {
    return defer(request).pipe(catchError((error: unknown) => throwError(() => this.toUserError(error))));
  }

  private toUserError(error: unknown): Error {
    if (error instanceof HttpErrorResponse) {
      if (error.status === 0) {
        return new Error(
          'The browser did not receive a response from Frappe. Check network and TLS connectivity, and inspect the browser console for CORS or preflight errors. Angular cannot distinguish these browser-level failures by status alone.',
        );
      }

      const isLoginRequest = error.url?.split('?')[0].endsWith('/api/method/login') ?? false;
      if (isLoginRequest && (error.status === 400 || error.status === 401)) {
        return new Error('Frappe rejected the login. Check the username and password, or verify the account is allowed to sign in.');
      }
      if (isLoginRequest && error.status === 429) {
        return new Error('Frappe is temporarily rate-limiting login attempts. Wait a moment and try again.');
      }
      if (error.status === 403 && error.headers.get('cf-mitigated') === 'challenge') {
        return new Error(
          'Cloudflare blocked the Frappe API request with a security challenge. The Frappe/Cloudflare administrator must allow the Vercel proxy for the required API routes; this challenge cannot be completed by the login API client.',
        );
      }
      if (error.status === 401) {
        return new Error('Frappe sign-in is required or the session has expired.');
      }
      if (error.status === 403) {
        return new Error('Your Frappe account does not have permission for this action.');
      }
      if (error.status >= 500) {
        return new Error(`Frappe server error (HTTP ${error.status}). Please try again later or contact your Frappe administrator.`);
      }

      return new Error(`Frappe request failed (HTTP ${error.status}).`);
    }

    return error instanceof Error ? error : new Error('Unexpected Frappe request error.');
  }
}