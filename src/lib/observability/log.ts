/**
 * One-line JSON logs that can be searched and counted in Railway's Deploy Logs.
 *
 * Redaction is enforced here rather than left to each caller: a value is dropped
 * if its key names a credential or personal data, and any URL inside a string is
 * cut down to its origin, because Meta's CDN links and R2 links can be signed.
 */

export type LogLevel = 'info' | 'warn' | 'error';

const SENSITIVE_KEY =
  /token|secret|password|authorization|cookie|api_?key|phone|signature|credential/i;
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;

function scrubString(value: string): string {
  return value.replace(URL_PATTERN, (url) => {
    try {
      return `${new URL(url).origin}/[redacted]`;
    } catch {
      return '[redacted-url]';
    }
  });
}

function scrub(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return scrubString(value);
  if (value instanceof Error) return scrubString(value.message);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return '[truncated]';
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(item, depth + 1),
    ])
  );
}

/** Pure, so the redaction rules can be tested without capturing the console. */
export function formatLogLine(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {},
  now: Date = new Date()
): string {
  return JSON.stringify({
    ts: now.toISOString(),
    level,
    event,
    ...(scrub(fields) as Record<string, unknown>),
  });
}

export function logEvent(
  level: LogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const line = formatLogLine(level, event, fields);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);
}
