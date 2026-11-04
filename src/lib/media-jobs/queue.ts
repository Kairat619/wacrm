import type { SupabaseClient } from '@supabase/supabase-js';

export type MediaJobStatus =
  | 'pending'
  | 'downloading'
  | 'stored'
  | 'retrying'
  | 'unavailable'
  | 'failed';

export interface MediaJobRow {
  id: string;
  account_id: string;
  message_row_id: string;
  media_id: string;
  mime_type: string | null;
  file_name: string | null;
  status: MediaJobStatus;
  attempts: number;
  max_attempts: number;
  storage_key: string | null;
  content_type: string | null;
  byte_size: number | null;
  sha256: string | null;
  rate_limit_hits: number;
  created_at: string;
}

/**
 * Create the job for an attachment. One media id gets one job, however many
 * times Meta redelivers it (migration 062's unique constraint). Throws on a
 * database error so the webhook event is retried rather than losing the job.
 */
export async function enqueueMediaJob(
  db: SupabaseClient,
  job: {
    accountId: string;
    messageRowId: string;
    mediaId: string;
    mimeType: string | null;
    fileName: string | null;
  }
): Promise<void> {
  const { error } = await db.from('media_jobs').upsert(
    {
      account_id: job.accountId,
      message_row_id: job.messageRowId,
      media_id: job.mediaId,
      mime_type: job.mimeType,
      file_name: job.fileName,
    },
    { onConflict: 'account_id,media_id', ignoreDuplicates: true }
  );
  if (error) throw new Error(`enqueueing media job failed: ${error.message}`);
}

/** Lease covers the longest download plus the longest upload. */
export const MEDIA_JOB_LEASE_SECONDS = 15 * 60;

export async function claimMediaJobs(
  db: SupabaseClient,
  worker: string,
  limit: number
): Promise<MediaJobRow[]> {
  const { data, error } = await db.rpc('claim_media_jobs', {
    p_worker: worker,
    p_limit: limit,
    p_lease_seconds: MEDIA_JOB_LEASE_SECONDS,
  });
  if (error) throw new Error(`claiming media jobs failed: ${error.message}`);
  return (data ?? []) as MediaJobRow[];
}

/** The caller supplies the account, which is what keeps this tenant-scoped. */
export async function findMediaJob(
  db: SupabaseClient,
  accountId: string,
  mediaId: string
): Promise<Pick<MediaJobRow, 'status' | 'storage_key' | 'content_type'> | null> {
  const { data, error } = await db
    .from('media_jobs')
    .select('status, storage_key, content_type')
    .eq('account_id', accountId)
    .eq('media_id', mediaId)
    .maybeSingle();
  if (error) throw new Error(`reading media job failed: ${error.message}`);
  return data;
}
