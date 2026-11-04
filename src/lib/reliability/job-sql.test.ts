import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * Runs the real migration SQL against real Postgres (PGlite, in process), because
 * a mocked client can't prove leases, unique indexes or constraints work.
 *
 * Limit: PGlite has one connection, so this checks what the claim functions
 * select and change, but not two sessions competing under SKIP LOCKED.
 */
const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations');

function migration(prefix: string): string {
  const file = readdirSync(MIGRATIONS).find((name) => name.startsWith(prefix));
  if (!file) throw new Error(`no migration ${prefix}`);
  return readFileSync(join(MIGRATIONS, file), 'utf8');
}

let db: PGlite;

const ACCOUNT = '00000000-0000-0000-0000-000000000001';
const MESSAGE = '00000000-0000-0000-0000-000000000002';
const CONVERSATION = '00000000-0000-0000-0000-000000000003';

beforeAll(async () => {
  db = new PGlite();
  // Only what these migrations reference.
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE accounts (id UUID PRIMARY KEY);
    CREATE TABLE conversations (id UUID PRIMARY KEY, account_id UUID);
    CREATE TABLE messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id UUID,
      message_id TEXT,
      error_title TEXT,
      status TEXT NOT NULL DEFAULT 'sent'
        CHECK (status IN ('sending', 'sent', 'delivered', 'read', 'failed'))
    );
    INSERT INTO conversations VALUES ('${CONVERSATION}', '${ACCOUNT}');
    INSERT INTO accounts VALUES ('${ACCOUNT}');
    INSERT INTO messages (id) VALUES ('${MESSAGE}');
  `);
  await db.exec(migration('061'));
  await db.exec(migration('062'));
  // Includes the constraint swap, against a table holding existing rows.
  await db.exec(migration('063'));
}, 60_000);

beforeEach(async () => {
  await db.exec('DELETE FROM webhook_events; DELETE FROM media_jobs;');
});

async function ids(sql: string, params: unknown[] = []): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(sql, params);
  return rows.map((row) => row.id);
}

describe('claim_webhook_events', () => {
  const claim = (id: string | null = null, maxAttempts = 3) =>
    db.query<{ id: string; status: string; attempts: number }>(
      'SELECT * FROM claim_webhook_events(10, 300, $1, $2)',
      [maxAttempts, id]
    );
  const insert = async (hash: string, extra = '') => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO webhook_events (payload_hash, payload) VALUES ($1, '{}') RETURNING id`,
      [hash]
    );
    if (extra) await db.query(`UPDATE webhook_events SET ${extra} WHERE id = $1`, [rows[0].id]);
    return rows[0].id;
  };

  it('rejects the same payload twice', async () => {
    await insert('same');
    await expect(insert('same')).rejects.toThrow(/unique/i);
  });

  it('claims a pending event once, and not again while its lease runs', async () => {
    const id = await insert('a');

    const first = await claim();
    expect(first.rows.map((r) => r.id)).toEqual([id]);
    expect(first.rows[0]).toMatchObject({ status: 'processing', attempts: 1 });
    expect((await claim()).rows).toHaveLength(0);
  });

  it('recovers an event whose worker died, once its lease expires', async () => {
    const id = await insert('a', `status = 'processing', attempts = 1, locked_until = NOW() - INTERVAL '1 minute'`);

    const { rows } = await claim();

    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0].attempts).toBe(2);
  });

  it('does not claim an event scheduled for later', async () => {
    await insert('a', `next_attempt_at = NOW() + INTERVAL '1 hour'`);
    expect((await claim()).rows).toHaveLength(0);
  });

  it('claims only the requested event when given an id', async () => {
    await insert('a');
    const wanted = await insert('b');

    expect((await claim(wanted)).rows.map((r) => r.id)).toEqual([wanted]);
  });

  it('fails an event that keeps killing its worker, rather than looping', async () => {
    const id = await insert('a', `status = 'processing', attempts = 3, locked_until = NOW() - INTERVAL '1 minute'`);

    expect((await claim()).rows).toHaveLength(0);
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM webhook_events WHERE id = $1',
      [id]
    );
    expect(rows[0].status).toBe('failed');
  });

  it('never returns finished events', async () => {
    await insert('a', `status = 'done'`);
    await insert('b', `status = 'failed'`);
    expect((await claim()).rows).toHaveLength(0);
  });
});

describe('media_jobs', () => {
  const claim = (limit = 10) =>
    db.query<{ id: string; status: string; attempts: number; locked_by: string }>(
      `SELECT * FROM claim_media_jobs('w1', $1, 900)`,
      [limit]
    );
  const insert = async (mediaId: string, extra = '') => {
    const [id] = await ids(
      `INSERT INTO media_jobs (account_id, message_row_id, media_id) VALUES ($1, $2, $3) RETURNING id`,
      [ACCOUNT, MESSAGE, mediaId]
    );
    if (extra) await db.query(`UPDATE media_jobs SET ${extra} WHERE id = $1`, [id]);
    return id;
  };

  it('allows only one job per media id: duplicate processing is impossible', async () => {
    await insert('m1');
    await expect(insert('m1')).rejects.toThrow(/unique/i);
  });

  it('accepts exactly the six specified states', async () => {
    const id = await insert('m1');
    for (const status of ['pending', 'downloading', 'stored', 'retrying', 'unavailable', 'failed']) {
      await db.query('UPDATE media_jobs SET status = $1 WHERE id = $2', [status, id]);
    }
    await expect(
      db.query(`UPDATE media_jobs SET status = 'other' WHERE id = $1`, [id])
    ).rejects.toThrow(/check/i);
  });

  it('claims a job once, and records who holds it', async () => {
    const id = await insert('m1');

    const first = await claim();
    expect(first.rows[0]).toMatchObject({ id, status: 'downloading', attempts: 1, locked_by: 'w1' });
    expect((await claim()).rows).toHaveLength(0);
  });

  it('respects the claim limit, which bounds concurrency', async () => {
    await insert('m1');
    await insert('m2');
    await insert('m3');

    expect((await claim(2)).rows).toHaveLength(2);
  });

  it('recovers a job after a worker restart, once its lease expires', async () => {
    const id = await insert('m1', `status = 'downloading', attempts = 2, locked_by = 'dead', locked_until = NOW() - INTERVAL '1 minute'`);

    const { rows } = await claim();

    expect(rows[0]).toMatchObject({ id, attempts: 3, locked_by: 'w1' });
  });

  it('leaves a job alone while another worker holds a live lease', async () => {
    await insert('m1', `status = 'downloading', locked_by = 'other', locked_until = NOW() + INTERVAL '5 minutes'`);
    expect((await claim()).rows).toHaveLength(0);
  });

  it('claims a due retry but not a future one', async () => {
    const due = await insert('m1', `status = 'retrying', next_attempt_at = NOW() - INTERVAL '1 second'`);
    await insert('m2', `status = 'retrying', next_attempt_at = NOW() + INTERVAL '1 hour'`);

    expect((await claim()).rows.map((r) => r.id)).toEqual([due]);
  });

  it.each(['stored', 'unavailable', 'failed'])('never reclaims a %s job', async (status) => {
    await insert('m1', `status = '${status}'`);
    expect((await claim()).rows).toHaveLength(0);
  });

  it('fails a job that keeps killing its worker, rather than looping', async () => {
    const id = await insert('m1', `status = 'downloading', attempts = 8, locked_until = NOW() - INTERVAL '1 minute'`);

    expect((await claim()).rows).toHaveLength(0);
    const { rows } = await db.query<{ status: string }>(
      'SELECT status FROM media_jobs WHERE id = $1',
      [id]
    );
    expect(rows[0].status).toBe('failed');
  });

  it('is removed along with its message', async () => {
    const [messageId] = await ids(`INSERT INTO messages DEFAULT VALUES RETURNING id`);
    const [jobId] = await ids(
      `INSERT INTO media_jobs (account_id, message_row_id, media_id) VALUES ($1, $2, 'm9') RETURNING id`,
      [ACCOUNT, messageId]
    );

    await db.query('DELETE FROM messages WHERE id = $1', [messageId]);

    expect(await ids('SELECT id FROM media_jobs WHERE id = $1', [jobId])).toEqual([]);
  });
});

describe('outbound state machine', () => {
  const insert = async (columns: Record<string, unknown> = {}) => {
    const row: Record<string, unknown> = { conversation_id: CONVERSATION, ...columns };
    const names = Object.keys(row);
    const [id] = await ids(
      `INSERT INTO messages (${names.join(', ')})
       VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row)
    );
    return id;
  };
  const statusOf = async (id: string) =>
    (await db.query<{ status: string }>('SELECT status FROM messages WHERE id = $1', [id]))
      .rows[0].status;
  const past = () => new Date(Date.now() - 60_000).toISOString();
  const future = () => new Date(Date.now() + 3_600_000).toISOString();

  beforeEach(async () => {
    await db.exec(`DELETE FROM messages WHERE id <> '${MESSAGE}'`);
  });

  it('can be applied a second time', async () => {
    await expect(db.exec(migration('063'))).resolves.toBeDefined();
  });

  it('accepts queued, and still rejects an unknown status', async () => {
    await expect(insert({ status: 'queued' })).resolves.toBeDefined();
    await expect(insert({ status: 'bogus' })).rejects.toThrow(/check/i);
  });

  it('rejects an unknown retry class', async () => {
    await expect(insert({ retry_class: 'whenever' })).rejects.toThrow(/check/i);
  });

  it('rejects a second row with the same request id: no duplicate sends', async () => {
    await insert({ client_request_id: 'req-1' });
    await expect(insert({ client_request_id: 'req-1' })).rejects.toThrow(/unique/i);
  });

  it('lets rows with no request id coexist', async () => {
    await insert();
    await expect(insert()).resolves.toBeDefined();
  });

  it('honours the ON CONFLICT clause the send path relies on', async () => {
    await insert({ client_request_id: 'req-1' });
    const { rows } = await db.query(
      `INSERT INTO messages (conversation_id, client_request_id) VALUES ($1, 'req-1')
       ON CONFLICT (conversation_id, client_request_id) DO NOTHING RETURNING id`,
      [CONVERSATION]
    );
    expect(rows).toHaveLength(0);
  });

  describe('claim_outbound_retries', () => {
    const claim = () =>
      db.query<{ id: string; account_id: string; send_attempts: number }>(
        'SELECT * FROM claim_outbound_retries(10)'
      );

    it('claims a due retry once, moving it to sending', async () => {
      const id = await insert({ status: 'queued', next_retry_at: past(), send_attempts: 1 });

      const { rows } = await claim();

      expect(rows[0]).toMatchObject({ id, account_id: ACCOUNT, send_attempts: 2 });
      expect(await statusOf(id)).toBe('sending');
      expect((await claim()).rows).toHaveLength(0);
    });

    it('leaves a retry that is not due yet', async () => {
      await insert({ status: 'queued', next_retry_at: future() });
      expect((await claim()).rows).toHaveLength(0);
    });

    it('ignores a queued row with no retry time: its first send is in progress', async () => {
      await insert({ status: 'queued' });
      expect((await claim()).rows).toHaveLength(0);
    });
  });

  describe('flag_stuck_outbound', () => {
    const flag = async () =>
      (await db.query<{ flag_stuck_outbound: number }>('SELECT flag_stuck_outbound(300)'))
        .rows[0].flag_stuck_outbound;

    it('flags a send whose process died for a person, and never queues it', async () => {
      const id = await insert({
        status: 'sending',
        sending_since: new Date(Date.now() - 600_000).toISOString(),
      });

      expect(await flag()).toBe(1);

      const { rows } = await db.query<Record<string, unknown>>(
        'SELECT status, retry_class, next_retry_at FROM messages WHERE id = $1',
        [id]
      );
      expect(rows[0]).toEqual({
        status: 'failed',
        retry_class: 'delivery_unknown',
        next_retry_at: null,
      });
    });

    it('leaves a send still within its time limit', async () => {
      const id = await insert({ status: 'sending', sending_since: new Date().toISOString() });

      expect(await flag()).toBe(0);
      expect(await statusOf(id)).toBe('sending');
    });

    it('ignores old-style rows with no start time', async () => {
      await insert({ status: 'sending' });
      expect(await flag()).toBe(0);
    });
  });
});

describe('table access', () => {
  it.each(['webhook_events', 'media_jobs'])('%s has row level security on', async (table) => {
    const { rows } = await db.query<{ relrowsecurity: boolean }>(
      'SELECT relrowsecurity FROM pg_class WHERE relname = $1',
      [table]
    );
    expect(rows[0].relrowsecurity).toBe(true);
  });

  it.each(['anon', 'authenticated'])('%s cannot run the claim functions', async (role) => {
    const { rows } = await db.query<{ allowed: boolean }>(
      `SELECT has_function_privilege($1, 'claim_media_jobs(text,integer,integer)', 'EXECUTE') AS allowed`,
      [role]
    );
    expect(rows[0].allowed).toBe(false);
  });
});
