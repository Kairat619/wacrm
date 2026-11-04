/**
 * Switches for the reliability rollout. All default to OFF, so merging the code
 * changes nothing until the matching migration is applied and the flag is set.
 * Turning one off restores the previous path. Read per call, so tests can set
 * them per case.
 */
function flag(name: string): boolean {
  return process.env[name] === 'true';
}

/** Save webhook payloads before acknowledging. Needs migration 061 and the worker. */
export function durableWebhookIntakeEnabled(): boolean {
  return flag('WEBHOOK_DURABLE_INTAKE');
}

/** Store inbound media in R2 through background jobs. Needs migration 062, the worker and R2. */
export function mediaJobsEnabled(): boolean {
  return flag('MEDIA_JOBS_ENABLED');
}

/** Save outbound messages before calling Meta. Needs migration 063 and the worker. */
export function outboundPersistFirstEnabled(): boolean {
  return flag('OUTBOUND_PERSIST_FIRST');
}
