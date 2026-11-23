import { describe, expect, it } from 'vitest';
import {
  buildContactsCsv,
  contactsCsvFilename,
  type ExportContact,
} from './contact-csv-export';
import { parseContactCsv } from './parse-contact-csv';

function contact(overrides: Partial<ExportContact> = {}): ExportContact {
  return {
    id: 'c1',
    phone: '+77001234567',
    name: 'Айгүл',
    email: 'a@example.com',
    company: 'Acme',
    wa_username: null,
    created_at: '2026-11-23T10:00:00Z',
    tagNames: [],
    customValues: {},
    ...overrides,
  };
}

function cells(csv: string, line = 1): string[] {
  return csv.split('\r\n')[line].slice(1, -1).split('","');
}

describe('buildContactsCsv', () => {
  it('starts with a UTF-8 BOM so Excel reads Cyrillic correctly', () => {
    const csv = buildContactsCsv([], []);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1, 8)).toBe('"phone"');
  });

  it('round-trips through the contacts importer', () => {
    const csv = buildContactsCsv(
      [
        contact({ company: 'Acme, LLP', tagNames: ['Lead', 'VIP'] }),
        contact({ id: 'c2', phone: '+77007654321', name: 'Two\nLines' }),
      ],
      []
    );
    const parsed = parseContactCsv(csv);
    expect(parsed.hasPhoneColumn).toBe(true);
    expect(parsed.rows).toEqual([
      {
        phone: '+77001234567',
        name: 'Айгүл',
        email: 'a@example.com',
        company: 'Acme, LLP',
        tagNames: ['Lead', 'VIP'],
      },
      {
        phone: '+77007654321',
        name: 'Two Lines',
        email: 'a@example.com',
        company: 'Acme',
        tagNames: [],
      },
    ]);
  });

  it('appends custom fields by id and leaves missing values blank', () => {
    const csv = buildContactsCsv(
      [contact({ customValues: { f2: 'Almaty' } })],
      [
        { id: 'f1', field_name: 'Birthday' },
        { id: 'f2', field_name: 'City' },
      ]
    );
    expect(cells(csv, 0).slice(-2)).toEqual(['Birthday', 'City']);
    expect(cells(csv).slice(-2)).toEqual(['', 'Almaty']);
  });

  it('escapes embedded quotes', () => {
    expect(buildContactsCsv([contact({ name: 'A "B" C' })], [])).toContain(
      '"A ""B"" C"'
    );
  });

  it.each(['=HYPERLINK("x")', '+SUM(A1)', '-cmd|x', '@SUM(A1)', '\t=1+A1'])(
    'neutralizes the formula %j',
    (name) => {
      expect(cells(buildContactsCsv([contact({ name })], []))[1]).toMatch(
        /^'[=+\-@]/
      );
    }
  );

  it.each(['+77001234567', '+7 (700) 123-45-67'])(
    'leaves phone %j untouched',
    (phone) => {
      // Line 1 carries no BOM, so cell 0 is the bare phone.
      expect(cells(buildContactsCsv([contact({ phone })], []))[0]).toBe(phone);
    }
  );
});

describe('contactsCsvFilename', () => {
  it('zero-pads the local date', () => {
    expect(contactsCsvFilename(new Date(2026, 0, 5))).toBe(
      'contacts-2026-01-05.csv'
    );
  });
});
