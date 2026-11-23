import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  ExportContact,
  ExportCustomField,
} from '@/lib/contacts/contact-csv-export';
import { fetchAllPages } from '@/lib/supabase/paged-query';
import type { Contact } from '@/types';

const EXPORT_PAGE_SIZE = 500;

type ExportRow = Contact & {
  contact_tags: { tags: { name: string } | null }[];
  contact_custom_values: { custom_field_id: string; value: string | null }[];
};

const EXPORT_SELECT =
  '*, contact_tags(tags(name)), contact_custom_values(custom_field_id, value)';

/**
 * Every contact matching the Contacts page filters (not just the loaded
 * page), with tag names and custom field values. RLS scopes the result
 * to the caller's account. Throws if any page fails, so a partial list
 * is never mistaken for a complete export.
 */
export async function fetchContactsForExport(
  supabase: SupabaseClient,
  filters: { search: string; tagIds: string[] }
): Promise<{ contacts: ExportContact[]; customFields: ExportCustomField[] }> {
  const term = filters.search.trim();
  const { tagIds } = filters;

  const { data: fieldRows, error: fieldsError } = await supabase
    .from('custom_fields')
    .select('id, field_name')
    .order('field_name');
  if (fieldsError) throw new Error(fieldsError.message);

  const rows = await fetchAllPages<ExportRow>((from, to) => {
    // The aliased inner join only filters; the plain `contact_tags`
    // embed still returns all of each contact's tags.
    let query = supabase
      .from('contacts')
      .select(
        tagIds.length > 0
          ? `${EXPORT_SELECT}, tag_filter:contact_tags!inner(tag_id)`
          : EXPORT_SELECT
      );
    if (tagIds.length > 0) query = query.in('tag_filter.tag_id', tagIds);
    if (term) {
      const like = `%${term}%`;
      query = query.or(
        `name.ilike.${like},phone.ilike.${like},email.ilike.${like}`
      );
    }
    // `id` breaks created_at ties so pages can't overlap.
    return query
      .order('created_at', { ascending: false })
      .order('id')
      .range(from, to)
      .overrideTypes<ExportRow[], { merge: false }>();
  }, EXPORT_PAGE_SIZE);

  // A contact created mid-export shifts later pages down by one, which
  // repeats the boundary row.
  const unique = [...new Map(rows.map((r) => [r.id, r])).values()];

  return {
    customFields: fieldRows ?? [],
    contacts: unique.map((row) => ({
      id: row.id,
      phone: row.phone,
      name: row.name,
      email: row.email,
      company: row.company,
      wa_username: row.wa_username,
      created_at: row.created_at,
      tagNames: row.contact_tags.flatMap((ct) => ct.tags?.name ?? []).sort(),
      customValues: Object.fromEntries(
        row.contact_custom_values.map((v) => [v.custom_field_id, v.value ?? ''])
      ),
    })),
  };
}
