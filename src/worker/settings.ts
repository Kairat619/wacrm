/**
 * Settings the media jobs can't work without but wouldn't otherwise complain about.
 * Without ENCRYPTION_KEY the worker starts normally, then can't read any WhatsApp
 * token, so every job just waits and retries. Better to say so at startup.
 */
const ENCRYPTION_KEY_PATTERN = /^[0-9a-fA-F]{64}$/;

export function mediaSettingsProblem(
  env: Record<string, string | undefined> = process.env
): string | null {
  if (!ENCRYPTION_KEY_PATTERN.test(env.ENCRYPTION_KEY ?? '')) {
    return 'ENCRYPTION_KEY is missing or is not 64 hex characters';
  }
  return null;
}
