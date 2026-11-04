export interface ContactPhoneRecord {
  phone?: unknown;
  is_primary_phone?: unknown;
  is_primary_mobile?: unknown;
  is_primary_mobile_no?: unknown;
}

export interface CustomerPhoneNumbers {
  phoneNo: string;
  faxNo: string;
}

export function mapContactPhoneNumbers(records: ContactPhoneRecord[]): CustomerPhoneNumbers {
  const validRecords = records.flatMap((record) => {
    const phone = typeof record.phone === 'string' || typeof record.phone === 'number'
      ? String(record.phone).trim()
      : '';
    return phone ? [{ ...record, phone }] : [];
  });
  const primaryPhone = validRecords.find((record) => isChecked(record.is_primary_phone));
  const primaryMobile = validRecords.find((record) =>
    isChecked(record.is_primary_mobile) || isChecked(record.is_primary_mobile_no),
  );
  const firstPhone = validRecords[0]?.phone ?? '';

  return {
    phoneNo: primaryMobile?.phone ?? primaryPhone?.phone ?? firstPhone,
    faxNo: primaryPhone?.phone ?? primaryMobile?.phone ?? firstPhone,
  };
}

function isChecked(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}
