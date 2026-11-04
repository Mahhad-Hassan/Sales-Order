import { PaymentTermOption } from './sales-order.model';

export function calculatePaymentDueDate(invoiceDate: string, term: PaymentTermOption): string {
  const date = parseDate(invoiceDate);
  if (!date) {
    return '';
  }

  const days = Number.isFinite(term.credit_days) ? Number(term.credit_days) : 0;
  const months = Number.isFinite(term.credit_months) ? Number(term.credit_months) : 0;
  switch (term.due_date_based_on) {
    case 'Day(s) after invoice date':
      date.setDate(date.getDate() + days);
      break;
    case 'Day(s) after the end of the invoice month':
      date.setMonth(date.getMonth() + 1, 0);
      date.setDate(date.getDate() + days);
      break;
    case 'Month(s) after the end of the invoice month': {
      date.setMonth(date.getMonth() + 1, 0);
      const targetMonth = date.getMonth() + months;
      const targetYear = date.getFullYear() + Math.floor(targetMonth / 12);
      const normalizedMonth = ((targetMonth % 12) + 12) % 12;
      date.setFullYear(targetYear, normalizedMonth + 1, 0);
      break;
    }
    default:
      return '';
  }

  return formatDate(date);
}

export function formatDateForInput(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }
  const date = parseDate(value);
  return date ? formatDate(date) : '';
}

function parseDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return null;
  }
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return date.getFullYear() === Number(match[1])
    && date.getMonth() === Number(match[2]) - 1
    && date.getDate() === Number(match[3])
    ? date
    : null;
}

function formatDate(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}
