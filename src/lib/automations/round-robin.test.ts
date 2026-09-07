import { describe, expect, it } from 'vitest';
import {
  nextAgent,
  rotationPool,
  tallyAssignments,
  type RotationMember,
} from './round-robin';

const MEMBERS: RotationMember[] = [
  { user_id: 'owner-1', role: 'owner' },
  { user_id: 'agent-a', role: 'agent' },
  { user_id: 'agent-b', role: 'agent' },
  { user_id: 'agent-c', role: 'agent' },
  { user_id: 'viewer-1', role: 'viewer' },
];

describe('rotationPool', () => {
  it('leaves owners and viewers out by default', () => {
    expect(rotationPool(MEMBERS)).toEqual(['agent-a', 'agent-b', 'agent-c']);
  });

  it('includes admins alongside agents', () => {
    const pool = rotationPool([
      ...MEMBERS,
      { user_id: 'admin-1', role: 'admin' },
    ]);
    expect(pool).toContain('admin-1');
    expect(pool).not.toContain('owner-1');
  });

  it('honours an explicit member list, owners included', () => {
    expect(rotationPool(MEMBERS, ['agent-b', 'owner-1'])).toEqual([
      'agent-b',
      'owner-1',
    ]);
  });

  it('drops configured ids that are no longer members', () => {
    expect(rotationPool(MEMBERS, ['agent-a', 'departed'])).toEqual(['agent-a']);
  });

  it('falls back to the default pool when the list names nobody current', () => {
    expect(rotationPool(MEMBERS, ['departed'])).toEqual([
      'agent-a',
      'agent-b',
      'agent-c',
    ]);
  });

  it('falls back to the owner in an account with no other members', () => {
    expect(rotationPool([{ user_id: 'owner-1', role: 'owner' }])).toEqual([
      'owner-1',
    ]);
  });
});

describe('nextAgent', () => {
  const pool = ['agent-a', 'agent-b', 'agent-c'];

  it('cycles through the pool when everyone starts even', () => {
    const loads = new Map<string, number>();
    const picked: string[] = [];
    for (let i = 0; i < 6; i++) {
      const agent = nextAgent(pool, loads);
      expect(agent).toBeDefined();
      picked.push(agent!);
      loads.set(agent!, (loads.get(agent!) ?? 0) + 1);
    }
    expect(picked).toEqual([
      'agent-a',
      'agent-b',
      'agent-c',
      'agent-a',
      'agent-b',
      'agent-c',
    ]);
  });

  it('gives the next conversation to the least loaded agent', () => {
    const loads = new Map([
      ['agent-a', 4],
      ['agent-b', 1],
      ['agent-c', 3],
    ]);
    expect(nextAgent(pool, loads)).toBe('agent-b');
  });

  it('never picks someone outside the pool', () => {
    const loads = new Map([['owner-1', 0]]);
    expect(nextAgent(pool, loads)).toBe('agent-a');
  });

  it('returns undefined for an empty pool', () => {
    expect(nextAgent([], new Map())).toBeUndefined();
  });
});

describe('tallyAssignments', () => {
  it('counts per agent and ignores unassigned rows', () => {
    const loads = tallyAssignments([
      { assigned_agent_id: 'agent-a' },
      { assigned_agent_id: null },
      { assigned_agent_id: 'agent-a' },
      { assigned_agent_id: 'agent-b' },
    ]);
    expect(loads.get('agent-a')).toBe(2);
    expect(loads.get('agent-b')).toBe(1);
    expect(loads.has('agent-c')).toBe(false);
  });
});
