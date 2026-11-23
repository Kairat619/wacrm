/**
 * Contact list → CSV text. Pure and unit-tested; fetching lives in
 * `fetch-contacts-for-export.ts`.
 *
 * The first five headers are the ones `parseContactCsv` reads, so an
 * exported file can be re-imported on the Contacts page unchanged.
 */

export interface ExportContact {
  id: string;
  phone: string;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  wa_username?: string | null;
  created_at: string;
  tagNames: string[];
  /** custom_field_id → value */
  customValues: Record<string, string>;
}

export interface ExportCustomField {
  id: string;
  field_name: string;
}

const BASE_HEADERS = [
  'phone',
  'name',
  'email',
  'company',
  'tags',
  'whatsapp_username',
  'created_at',
];

// Excel assumes the system codepage for CSVs without a BOM, which
// garbles Cyrillic/Kazakh names.
const UTF8_BOM = String.fromCharCode(0xfeff);

/** Digits with an optional sign and phone punctuation — never a formula
 *  worth guarding, and quoting it would corrupt phone numbers. */
const PLAIN_NUMBER = /^[+-]?[\d\s().-]*$/;

/**
 * Contact names come from WhatsApp profiles, i.e. from strangers. A cell
 * starting with one of these is run as a formula when the file is opened
 * in a spreadsheet, so prefix it with an apostrophe (which the importer
 * strips again).
 */
function neutralizeFormula(value: string): string {
  if (!/^[=+\-@]/.test(value) || PLAIN_NUMBER.test(value)) return value;
  return `'${value}`;
}

function toCell(value: string | null | undefined): string {
  // The importer splits on line breaks before it looks at quotes.
  const singleLine = (value ?? '').replace(/[\r\n\t]+/g, ' ').trim();
  return `"${neutralizeFormula(singleLine).replace(/"/g, '""')}"`;
}

export function buildContactsCsv(
  contacts: readonly ExportContact[],
  customFields: readonly ExportCustomField[]
): string {
  const rows = [
    [...BASE_HEADERS, ...customFields.map((f) => f.field_name)],
    ...contacts.map((c) => [
      c.phone,
      c.name,
      c.email,
      c.company,
      c.tagNames.join(', '),
      c.wa_username,
      c.created_at,
      ...customFields.map((f) => c.customValues[f.id]),
    ]),
  ];
  return UTF8_BOM + rows.map((r) => r.map(toCell).join(',')).join('\r\n');
}

/** `contacts-2026-11-23.csv`, dated in the user's own timezone. */
export function contactsCsvFilename(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `contacts-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.csv`;
}
