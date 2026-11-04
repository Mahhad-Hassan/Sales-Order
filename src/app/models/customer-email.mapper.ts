export interface ContactEmailRecord {
  email_id?: unknown;
  is_primary?: unknown;
}

export interface CustomerEmailOptions {
  emails: string[];
  primaryEmail: string;
}

export function mapContactEmails(records: ContactEmailRecord[]): CustomerEmailOptions {
  const emails: string[] = [];
  const seen = new Set<string>();
  const primaryEmails: string[] = [];

  for (const record of records) {
    const email = normalizeEmail(record.email_id);
    if (!email) {
      continue;
    }

    const key = email.toLocaleLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      emails.push(email);
    }

    if (isChecked(record.is_primary) && !primaryEmails.some((primary) =>
      primary.toLocaleLowerCase() === key,
    )) {
      primaryEmails.push(email);
    }
  }

  return {
    emails,
    primaryEmail: primaryEmails[0] ?? emails[0] ?? '',
  };
}

function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  const email = value.trim();
  const parts = email.split('@');
  return parts.length === 2 && parts[0] && parts[1] && !/\s/.test(email) ? email : '';
}

function isChecked(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}
