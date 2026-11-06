import { Injectable, inject } from '@angular/core';
import { forkJoin, map, Observable, of, shareReplay, switchMap } from 'rxjs';
import { CustomerAddressOption, CustomerOption, CustomerPartyDetails } from '../models/customer-option.model';
import { ContactEmailRecord, mapContactEmails } from '../models/customer-email.mapper';
import { FrappeDocTypeField, FrappeDocTypeMetadata } from '../models/frappe-api.model';
import { ContactPhoneRecord, mapContactPhoneNumbers } from '../models/customer-phone.mapper';
import { FrappeApiService } from './frappe-api.service';

type FrappeDocument = Record<string, unknown>;

interface AddressReference {
  docName: string;
}

interface LoadedAddress {
  reference: AddressReference;
  document: FrappeDocument;
}

interface DynamicLinkRecord {
  name: string;
}

interface CustomerContactDetails {
  phoneRecords: ContactPhoneRecord[];
  emails: string[];
  primaryEmail: string;
}

function readTaxId(customer: FrappeDocument): string {
  const value = customer['tax_id'];
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
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
      switchMap((context) => this.loadDynamicLinks(docName, context.dynamicLinkMetadata).pipe(
        switchMap((dynamicLinks) => forkJoin({
          addresses: this.loadAddresses(
            context.customerMetadata,
            context.customer,
            dynamicLinks,
          ),
          contactDetails: this.loadContactDetails(dynamicLinks),
        }).pipe(
          map(({ addresses, contactDetails }) =>
            this.toCustomerOption(docName, context, addresses, contactDetails),
          ),
        )),
      )),
    );
  }

  private loadDynamicLinks(
    customerName: string,
    metadata: FrappeDocTypeMetadata,
  ): Observable<FrappeDocument[]> {
    const linkDoctype = this.fieldByLabel(metadata, ['Link DocType', 'Link Document Type']);
    const linkName = this.fieldByLabel(metadata, ['Link Name']);
    if (!linkDoctype || !linkName) {
      return of([]);
    }

    const filters = [
      [linkDoctype.fieldname, '=', 'Customer'],
      [linkName.fieldname, '=', customerName],
    ];
    return this.api.getList<DynamicLinkRecord>('Dynamic Link', ['name'], filters, 100).pipe(
      switchMap((records) => records.length
        ? forkJoin(records.map((record) =>
          this.api.getDocument<FrappeDocument>('Dynamic Link', record.name),
        ))
        : of([] as FrappeDocument[])),
    );
  }

  private loadAddresses(
    customerMetadata: FrappeDocTypeMetadata,
    customerDocument: FrappeDocument,
    dynamicLinks: FrappeDocument[],
  ): Observable<LoadedAddress[]> {
    const references = this.addressReferences(
      customerMetadata,
      customerDocument,
      dynamicLinks,
    );
    const uniqueReferences = [...references.reduce((byName, reference) => {
      byName.set(reference.docName, reference);
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
  }

  private addressReferences(
    customerMetadata: FrappeDocTypeMetadata,
    customerDocument: FrappeDocument,
    dynamicLinks: FrappeDocument[],
  ): AddressReference[] {
    const directReferences = customerMetadata.fields
      .filter((field) => field.fieldtype === 'Link' && field.options === 'Address')
      .flatMap((field) => {
        const docName = this.readValue(customerDocument, field);
        return docName ? [{ docName } as AddressReference] : [];
      });

    const parent = { fieldname: 'parent', label: 'Parent', fieldtype: 'Link' };
    return [
      ...directReferences,
      ...dynamicLinks.flatMap((record) => {
        if (this.readValue(record, { fieldname: 'parenttype', label: 'Parent Type', fieldtype: 'Data' }) !== 'Address') {
          return [];
        }
        const docName = this.readValue(record, parent);
        return docName ? [{ docName } as AddressReference] : [];
      }),
    ];
  }

  private loadContactDetails(dynamicLinks: FrappeDocument[]): Observable<CustomerContactDetails> {
    const contactNames = [...new Set(dynamicLinks.flatMap((record) => {
      const parentType = this.readValue(record, {
        fieldname: 'parenttype',
        label: 'Parent Type',
        fieldtype: 'Data',
      });
      const parent = this.readValue(record, { fieldname: 'parent', label: 'Parent', fieldtype: 'Link' });
      return parentType === 'Contact' && parent ? [parent] : [];
    }))];
    if (!contactNames.length) {
      return of({ phoneRecords: [], emails: [], primaryEmail: '' });
    }

    return forkJoin(contactNames.map((name) =>
      this.api.getDocument<FrappeDocument>('Contact', name),
    )).pipe(
      map((contacts) => {
        const phoneRecords = contacts.flatMap((contact) => this.contactPhoneRecords(contact));
        const emailRecords = contacts.flatMap((contact) => this.contactEmailRecords(contact));
        const { emails, primaryEmail } = mapContactEmails(emailRecords);
        return { phoneRecords, emails, primaryEmail };
      }),
    );
  }

  private contactPhoneRecords(contact: FrappeDocument): ContactPhoneRecord[] {
    const phoneRows = Array.isArray(contact['phone_nos'])
      ? contact['phone_nos'].filter((row): row is FrappeDocument =>
        typeof row === 'object' && row !== null && !Array.isArray(row),
      )
      : [];
    const validPhoneRows = phoneRows.filter((row) => this.readPhone(row['phone']));
    if (validPhoneRows.length) {
      return validPhoneRows.map((row) => ({
        phone: row['phone'],
        is_primary_phone: row['is_primary_phone'],
        is_primary_mobile: row['is_primary_mobile'],
        is_primary_mobile_no: row['is_primary_mobile_no'],
      }));
    }

    return [contact['phone'], contact['mobile_no']]
      .filter((phone) => this.readPhone(phone))
      .map((phone) => ({ phone }));
  }

  private contactEmailRecords(contact: FrappeDocument): ContactEmailRecord[] {
    const emailRows = Array.isArray(contact['email_ids'])
      ? contact['email_ids'].filter((row): row is FrappeDocument =>
        typeof row === 'object' && row !== null && !Array.isArray(row),
      )
      : [];
    return [
      ...emailRows.map((row) => ({
        email_id: row['email_id'],
        is_primary: row['is_primary'],
      })),
      { email_id: contact['email_id'] },
    ];
  }

  private readPhone(value: unknown): string {
    return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  }

  private toCustomerOption(
    docName: string,
    context: {
      customerMetadata: FrappeDocTypeMetadata;
      addressMetadata: FrappeDocTypeMetadata;
      customer: FrappeDocument;
    },
    addresses: LoadedAddress[],
    contactDetails: CustomerContactDetails,
  ): CustomerOption {
    const displayField = this.fieldByLabel(context.customerMetadata, ['Customer Name']);
    const displayName = this.readValue(context.customer, displayField) || docName;
    const taxId = readTaxId(context.customer);
    const personName = [
      this.readValue(context.customer, this.fieldByLabel(context.customerMetadata, ['First Name'])),
      this.readValue(context.customer, this.fieldByLabel(context.customerMetadata, ['Last Name'])),
    ].filter(Boolean).join(' ');
    const contactPhones = mapContactPhoneNumbers(contactDetails.phoneRecords);
    const customerDetails: CustomerPartyDetails = {
      name: personName || displayName,
      companyName: displayName,
      postalAddress: '',
      phoneNo: contactPhones.phoneNo,
      faxNo: contactPhones.faxNo,
      email: contactDetails.primaryEmail,
      ntn: taxId,
    };
    const billToAddresses: CustomerAddressOption[] = [];
    const shipToAddresses: CustomerAddressOption[] = [];

    for (const { reference, document } of addresses) {
      const details: CustomerPartyDetails = {
        ...customerDetails,
        ...this.toPartyDetails(document, context.addressMetadata, displayName, customerDetails.ntn),
        phoneNo: contactPhones.phoneNo,
        faxNo: contactPhones.faxNo,
        email: contactDetails.primaryEmail,
      };
      const addressOption: CustomerAddressOption = {
        docName: reference.docName,
        label: this.addressLabel(document, context.addressMetadata, reference.docName, details),
        details: {
          ...details,
          name: details.name || customerDetails.name,
          phoneNo: details.phoneNo || customerDetails.phoneNo,
          email: details.email || customerDetails.email,
        },
      };
      billToAddresses.push(addressOption);
      shipToAddresses.push(addressOption);
    }

    this.prioritizeAddress(billToAddresses, 'billing', 'is_primary_address', addresses, context.addressMetadata);
    this.prioritizeAddress(shipToAddresses, 'shipping', 'is_shipping_address', addresses, context.addressMetadata);

    return {
      docName,
      displayName,
      taxId,
      billTo: billToAddresses[0]?.details ?? customerDetails,
      shipTo: shipToAddresses[0]?.details ?? customerDetails,
      billToAddresses,
      shipToAddresses,
      emails: contactDetails.emails,
    };
  }

  private toSearchOption(record: FrappeDocument, displayField?: FrappeDocTypeField): CustomerOption {
    const docName = this.readValue(record, { fieldname: 'name', label: 'Name', fieldtype: 'Data' });
    return {
      docName,
      displayName: this.readValue(record, displayField) || docName,
      taxId: '',
      billTo: {},
      shipTo: {},
      billToAddresses: [],
      shipToAddresses: [],
      emails: [],
    };
  }

  private toPartyDetails(
    address: FrappeDocument,
    metadata: FrappeDocTypeMetadata,
    customerName: string,
    taxId: string,
  ): CustomerPartyDetails {
    const title = this.readValue(address, this.fieldByLabel(metadata, ['Address Title']));
    const addressType = this.readValue(address, this.fieldByLabel(metadata, ['Address Type']));
    const addressLines = [
      title,
      addressType ? `(${addressType})` : '',
      this.readValue(address, this.fieldByLabel(metadata, ['Address Line 1', 'Address Line1'])),
      this.readValue(address, this.fieldByLabel(metadata, ['Address Line 2', 'Address Line2'])),
      this.readValue(address, this.fieldByLabel(metadata, ['City', 'City/Town'])),
      this.readValue(address, this.fieldByLabel(metadata, ['State', 'Province'])),
      this.readValue(address, this.fieldByLabel(metadata, ['Postal Code', 'Pincode', 'PIN'])),
      this.readValue(address, this.fieldByLabel(metadata, ['Country'])),
    ].filter(Boolean);

    return {
      name: title,
      companyName: customerName,
      postalAddress: addressLines.join('\n'),
      phoneNo: this.readValue(address, this.fieldByLabel(metadata, ['Phone', 'Phone No', 'Phone Number'])),
      faxNo: this.readValue(address, this.fieldByLabel(metadata, ['Fax', 'Fax No'])),
      email: this.readValue(address, this.fieldByLabel(metadata, ['Email', 'Email Id', 'Email Address'])),
      ntn: taxId,
    };
  }

private addressLabel(
  address: FrappeDocument,
  metadata: FrappeDocTypeMetadata,
  docName: string,
  details: CustomerPartyDetails,
): string {
  const title =
    this.readValue(address, this.fieldByLabel(metadata, ['Address Title'])) || docName;

  const type = this.readValue(
    address,
    this.fieldByLabel(metadata, ['Address Type']),
  );

  // Return the complete multiline address.
  // Fallback to title and address type if postalAddress is empty.
  return details.postalAddress || (type ? `${title}\n(${type})` : title);
}

  private prioritizeAddress(
    options: CustomerAddressOption[],
    preferredType: 'billing' | 'shipping',
    preferredFieldName: string,
    addresses: LoadedAddress[],
    metadata: FrappeDocTypeMetadata,
  ): void {
    const priorities = new Map(addresses.map(({ reference, document }) => {
      const type = this.normalize(this.readValue(document, this.fieldByLabel(metadata, ['Address Type'])));
      const hasPreferredType = type === preferredType || type === `${preferredType}address`;
      const isPreferredAddress = this.isEnabled(document[preferredFieldName]);
      return [reference.docName, hasPreferredType ? 2 : isPreferredAddress ? 1 : 0] as const;
    }));
    options.sort((left, right) =>
      (priorities.get(right.docName) ?? 0) - (priorities.get(left.docName) ?? 0),
    );
  }

  private isEnabled(value: unknown): boolean {
    return value === 1 || value === true || value === '1';
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