export interface CustomerPartyDetails {
  name: string;
  companyName: string;
  postalAddress: string;
  phoneNo: string;
  faxNo: string;
  email: string;
  ntn: string;
}

export interface CustomerAddressOption {
  docName: string;
  label: string;
  details: CustomerPartyDetails;
}

export interface CustomerOption {
  docName: string;
  displayName: string;
  billTo: Partial<CustomerPartyDetails>;
  shipTo: Partial<CustomerPartyDetails>;
  billToAddresses: CustomerAddressOption[];
  shipToAddresses: CustomerAddressOption[];
}

export const EMPTY_CUSTOMER_PARTY: CustomerPartyDetails = {
  name: '',
  companyName: '',
  postalAddress: '',
  phoneNo: '',
  faxNo: '',
  email: '',
  ntn: '',
};