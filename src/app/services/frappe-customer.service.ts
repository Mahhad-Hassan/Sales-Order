import { Injectable, inject } from '@angular/core';
import { forkJoin, map, Observable, of, shareReplay, switchMap } from 'rxjs';
import { CustomerOption, CustomerPartyDetails, EMPTY_CUSTOMER_PARTY } from '../models/customer-option.model';
import { FrappeDocTypeField, FrappeDocTypeMetadata } from '../models/frappe-api.model';
import { FrappeApiService } from './frappe-api.service';

type AddressTarget = 'billTo' | 'shipTo' | null;
type FrappeDocument = Record<string, unknown>;

interface AddressReference {
  docName: string;
  target: AddressTarget;
}

interface LoadedAddress {
  reference: AddressReference;
  document: FrappeDocument;
}

@Injectable({ providedIn: 'root' })
export class FrappeCustomerService {
  private readonly api = inject(FrappeApiService);
  private readonly customerMetadata$ = this.api
    .getDocument<FrappeDocTypeMetadata>('DocType', 'Customer')
    .pipe(shareReplay({ bufferSize: 1, refCount: true }));

  searchCustomers(query: string): Observable<CustomerOption[]> {
    return this.customerMetadata$.pipe(
      switchMap((metadata) => {
        const displayField = this.fieldByLabel(metadata, ['Customer Name']);
        const fields = ['name', ...(displayField ? [displayField.fieldname] : [])];
        const term = query.trim();
        const filters = displayField && term
          ? [[displayField.fieldname, 'like', `%${term}%`]]
          : [];

        return this.api.getList<FrappeDocument>('Customer', fields, filters, 20).pipe(
          map((records) => records
            .map((record) => this.toSearchOption(record, displayField))
            .filter((customer) =>
              !term || `${customer.displayName} ${customer.docName}`.toLocaleLowerCase().includes(term.toLocaleLowerCase()),
            )),
        );
      }),
    );
  }

  getCustomerDetails(docName: string): Observable<CustomerOption> {
    return forkJoin({
      customerMetadata: this.customerMetadata$,
      addressMetadata: this.api.getDocument<FrappeDocTypeMetadata>('DocType', 'Address'),
      dynamicLinkMetadata: this.api.getDocument<FrappeDocTypeMetadata>('DocType', 'Dynamic Link'),
      customer: this.api.getDocument<FrappeDocument>('Customer', docName),
    }).pipe(
      switchMap((context) => this.loadAddresses(
        docName,
        context.customerMetadata,
        context.dynamicLinkMetadata,
        context.customer,
      ).pipe(
        map((addresses) => this.toCustomerOption(docName, context, addresses)),
      )),
    );
  }

  private loadAddresses(
    customerName: string,
    customerMetadata: FrappeDocTypeMetadata,
    dynamicLinkMetadata: FrappeDocTypeMetadata,
    customerDocument: FrappeDocument,
  ): Observable<LoadedAddress[]> {
    return this.addressReferences(customerName, customerMetadata, dynamicLinkMetadata, customerDocument).pipe(
      switchMap((references) => {
        const uniqueReferences = [...references.reduce((byName, reference) => {
          const current = byName.get(reference.docName);
          if (!current || (!current.target && reference.target)) {
            byName.set(reference.docName, reference);
          }
          return byName;
        }, new Map<string, AddressReference>()).values()];
        if (!uniqueReferences.length) {
          return of([]);
        }

        return forkJoin(uniqueReferences.map((reference) =>
          this.api.getDocument<FrappeDocument>('Address', reference.docName).pipe(
            map((document) => ({ reference, document })),
          ),
        ));
      }),
    );
  }

  private addressReferences(
    customerName: string,
    customerMetadata: FrappeDocTypeMetadata,
    dynamicLinkMetadata: FrappeDocTypeMetadata,
    customerDocument: FrappeDocument,
  ): Observable<AddressReference[]> {
    const directReferences = customerMetadata.fields
      .filter((field) => field.fieldtype === 'Link' && field.options === 'Address')
      .flatMap((field) => {
        const docName = this.readValue(customerDocument, field);
        const label = this.normalize(field.label);
        const target = label.includes('bill')
          ? 'billTo'
          : label.includes('ship')
            ? 'shipTo'
            : null;
        return docName && target ? [{ docName, target } as AddressReference] : [];
      });

    const linkDoctype = this.fieldByLabel(dynamicLinkMetadata, ['Link DocType', 'Link Document Type']);
    const linkName = this.fieldByLabel(dynamicLinkMetadata, ['Link Name']);
    const parent = this.fieldByLabel(dynamicLinkMetadata, ['Parent']);
    const parentType = this.fieldByLabel(dynamicLinkMetadata, ['Parent Type', 'Parenttype']);
    if (!linkDoctype || !linkName || !parent || !parentType) {
      return of(directReferences);
    }

    const fields = [linkDoctype, linkName, parent, parentType].map((field) => field.fieldname);
    const filters = [
      [linkDoctype.fieldname, '=', 'Customer'],
      [linkName.fieldname, '=', customerName],
      [parentType.fieldname, '=', 'Address'],
    ];

    return this.api.getList<FrappeDocument>('Dynamic Link', fields, filters, 100).pipe(
      map((records) => [
        ...directReferences,
        ...records.flatMap((record) => {
          const docName = this.readValue(record, parent);
          return docName ? [{ docName, target: null } as AddressReference] : [];
        }),
      ]),
    );
  }

  private toCustomerOption(
    docName: string,
    context: {
      customerMetadata: FrappeDocTypeMetadata;
      addressMetadata: FrappeDocTypeMetadata;
      customer: FrappeDocument;
    },
    addresses: LoadedAddress[],
  ): CustomerOption {
    const displayField = this.fieldByLabel(context.customerMetadata, ['Customer Name']);
    const displayName = this.readValue(context.customer, displayField) || docName;
    const taxField = this.fieldByLabel(context.customerMetadata, ['NTN', 'Tax ID']);
    const option: CustomerOption = {
      docName,
      displayName,
      billTo: { ...EMPTY_CUSTOMER_PARTY },
      shipTo: { ...EMPTY_CUSTOMER_PARTY },
    };
    const assignedTargets = new Set<AddressTarget>();

    for (const { reference, document } of addresses) {
      const target = reference.target ?? this.addressTarget(document, context.addressMetadata);
      if (!target || assignedTargets.has(target)) {
        continue;
      }

      option[target] = this.toPartyDetails(
        document,
        context.addressMetadata,
        displayName,
        this.readValue(context.customer, taxField),
      );
      assignedTargets.add(target);
    }

    return option;
  }

  private toSearchOption(record: FrappeDocument, displayField?: FrappeDocTypeField): CustomerOption {
    const docName = this.readValue(record, { fieldname: 'name', label: 'Name', fieldtype: 'Data' });
    return {
      docName,
      displayName: this.readValue(record, displayField) || docName,
      billTo: {},
      shipTo: {},
    };
  }

  private toPartyDetails(
    address: FrappeDocument,
    metadata: FrappeDocTypeMetadata,
    customerName: string,
    taxId: string,
  ): CustomerPartyDetails {
    const addressLines = [
      this.readValue(address, this.fieldByLabel(metadata, ['Address Line 1', 'Address Line1'])),
      this.readValue(address, this.fieldByLabel(metadata, ['Address Line 2', 'Address Line2'])),
      this.readValue(address, this.fieldByLabel(metadata, ['City'])),
      this.readValue(address, this.fieldByLabel(metadata, ['State', 'Province'])),
      this.readValue(address, this.fieldByLabel(metadata, ['Postal Code', 'Pincode', 'PIN'])),
      this.readValue(address, this.fieldByLabel(metadata, ['Country'])),
    ].filter(Boolean);

    return {
      name: this.readValue(address, this.fieldByLabel(metadata, ['Address Title'])),
      companyName: customerName,
      postalAddress: addressLines.join(', '),
      phoneNo: this.readValue(address, this.fieldByLabel(metadata, ['Phone', 'Phone No', 'Phone Number'])),
      faxNo: this.readValue(address, this.fieldByLabel(metadata, ['Fax', 'Fax No'])),
      email: this.readValue(address, this.fieldByLabel(metadata, ['Email', 'Email Id'])),
      ntn: taxId,
    };
  }

  private addressTarget(address: FrappeDocument, metadata: FrappeDocTypeMetadata): AddressTarget {
    const typeField = this.fieldByLabel(metadata, ['Address Type']);
    const type = this.normalize(this.readValue(address, typeField));
    if (type.includes('billing') || type === 'billto') {
      return 'billTo';
    }
    if (type.includes('shipping') || type === 'shipto') {
      return 'shipTo';
    }
    return null;
  }

  private fieldByLabel(
    metadata: FrappeDocTypeMetadata,
    labels: string[],
  ): FrappeDocTypeField | undefined {
    const wanted = labels.map((label) => this.normalize(label));
    return (metadata.fields ?? []).find((field) =>
      wanted.includes(this.normalize(field.label)) || wanted.includes(this.normalize(field.fieldname)),
    );
  }

  private readValue(document: FrappeDocument | undefined, field?: FrappeDocTypeField): string {
    if (!document || !field) {
      return '';
    }
    const value = document[field.fieldname];
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  }

  private normalize(value: string | undefined): string {
    return (value ?? '').toLocaleLowerCase().replace(/[^a-z0-9]/g, '');
  }

}