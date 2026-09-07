/**
 * Agent pool + pick logic for the `assign_conversation` step's round-robin
 * mode. Kept free of I/O so the rules are testable on their own; the engine
 * supplies the rows.
 */

export type RotationRole = 'owner' | 'admin' | 'agent' | 'viewer';

export interface RotationMember {
  user_id: string;
  role: RotationRole;
}

/**
 * Who rotation targets when the step names no one explicitly. Owners are
 * excluded on purpose — an owner is an account holder, not a queue worker,
 * and the previous implementation handing them every conversation is the
 * bug this replaces. Viewers cannot reply at all, so they are out too.
 */
const DEFAULT_ROTATION_ROLES: readonly RotationRole[] = ['admin', 'agent'];

/**
 * The members a round-robin step rotates between, in a stable order.
 *
 * `configuredIds` (the step's `agent_ids`) wins when it names at least one
 * current member — that is the author saying "these three people". Otherwise
 * every admin/agent in the account takes part. An account whose only member
 * is its owner falls back to that owner: assigning to someone beats leaving
 * the conversation unassigned.
 */
export function rotationPool(
  members: RotationMember[],
  configuredIds?: string[],
): string[] {
  const byId = new Map(members.map((m) => [m.user_id, m]));

  if (configuredIds?.length) {
    const configured = configuredIds.filter((id) => byId.has(id));
    if (configured.length > 0) return [...new Set(configured)];
  }

  const eligible = members
    .filter((m) => DEFAULT_ROTATION_ROLES.includes(m.role))
    .map((m) => m.user_id)
    .sort();
  if (eligible.length > 0) return eligible;

  return members.map((m) => m.user_id).sort();
}

/**
 * The next agent in the rotation: whoever currently holds the fewest live
 * conversations, ties broken by pool order.
 *
 * There is no cursor column to store "who got the last one", so the rotation
 * is derived from the assignments themselves. With an even starting point
 * that produces the same cycle a counter would, and unlike a counter it
 * self-corrects — an agent who goes on leave and gets unassigned catches
 * back up instead of being handed every other conversation regardless.
 */
export function nextAgent(
  pool: string[],
  openConversationsByAgent: Map<string, number>,
): string | undefined {
  let best: string | undefined;
  let bestLoad = Infinity;
  for (const agentId of pool) {
    const load = openConversationsByAgent.get(agentId) ?? 0;
    if (load < bestLoad) {
      best = agentId;
      bestLoad = load;
    }
  }
  return best;
}

/** Tallies `assigned_agent_id` rows into the load map `nextAgent` expects. */
export function tallyAssignments(
  rows: { assigned_agent_id: string | null }[],
): Map<string, number> {
  const loads = new Map<string, number>();
  for (const row of rows) {
    if (!row.assigned_agent_id) continue;
    loads.set(row.assigned_agent_id, (loads.get(row.assigned_agent_id) ?? 0) + 1);
  }
  return loads;
}
