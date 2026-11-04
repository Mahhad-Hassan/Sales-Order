export interface CustomerPartyDetails {
  name: string;
  companyName: string;
  postalAddress: string;
  phoneNo: string;
  faxNo: string;
  email: string;
  ntn: string;
}

export interface CustomerOption {
  docName: string;
  displayName: string;
  billTo: Partial<CustomerPartyDetails>;
  shipTo: Partial<CustomerPartyDetails>;
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