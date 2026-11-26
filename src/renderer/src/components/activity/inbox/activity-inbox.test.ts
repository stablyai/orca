import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentPaneThread } from '../threads/activity-thread-types'
import { activityInboxKind, hasActivityInboxAgentAttention } from './activity-inbox'

const NOW = 1_000_000

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW - 1000,
    agentType: 'claude',
    paneKey: 'tab-1:leaf-1',
    terminalTitle: 'claude',
    stateHistory: [],
    ...overrides
  }
}

function source(
  entries: Record<string, AgentStatusEntry>,
  {
    acked = {},
    rows = Object.keys(entries)
  }: { acked?: Record<string, number>; rows?: string[] } = {}
): Parameters<typeof hasActivityInboxAgentAttention>[0] {
  const map = new Map(Object.entries(entries))
  const statuses = Object.assign(map, {
    projection: { rowWorktree: (paneKey: string) => (rows.includes(paneKey) ? 'wt' : null) }
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only entries() and projection.rowWorktree.
  return {
    agentStatusByPaneKey: statuses as unknown as AppState['agentStatusByPaneKey'],
    migrationUnsupportedByPtyId: {},
    acknowledgedAgentsByPaneKey: acked,
    activityClearedAtByPaneKey: {}
  }
}

describe('hasActivityInboxAgentAttention', () => {
  it('lights for a fresh waiting or blocked agent', () => {
    expect(hasActivityInboxAgentAttention(source({ a: entry({ state: 'waiting' }) }), NOW)).toBe(
      true
    )
    expect(hasActivityInboxAgentAttention(source({ a: entry({ state: 'blocked' }) }), NOW)).toBe(
      true
    )
  })

  it('stays dark for running work, which is progress and not news', () => {
    const working = entry({ state: 'working', stateStartedAt: NOW - 10 })
    expect(hasActivityInboxAgentAttention(source({ a: working }, { acked: { a: NOW } }), NOW)).toBe(
      false
    )
  })

  it('lights for an unread outcome and clears once it is read', () => {
    expect(hasActivityInboxAgentAttention(source({ a: entry() }), NOW)).toBe(true)
    expect(hasActivityInboxAgentAttention(source({ a: entry() }, { acked: { a: NOW } }), NOW)).toBe(
      false
    )
  })

  it('goes dark once a new turn starts, as the row leaves the list', () => {
    const working = entry({
      state: 'working',
      stateStartedAt: NOW - 10,
      stateHistory: [{ state: 'done', startedAt: NOW - 500 } as AgentStatusEntry['stateHistory'][0]]
    })
    expect(
      hasActivityInboxAgentAttention(source({ a: working }, { acked: { a: NOW - 1000 } }), NOW)
    ).toBe(false)
  })

  it('ignores a dispatched child worker', () => {
    const child = entry({ orchestration: { taskId: 't', dispatchId: 'd' } })
    expect(hasActivityInboxAgentAttention(source({ a: child }), NOW)).toBe(false)
  })

  it('stays dark for a cancelled turn, which the list shows as Interrupted and never lists', () => {
    const cancelled = entry({ interrupted: true })
    expect(hasActivityInboxAgentAttention(source({ a: cancelled }), NOW)).toBe(false)
  })

  it('lights for an unread failed main agent even while its row is still live, as the list lists it', () => {
    const failed = entry({
      state: 'working',
      stateStartedAt: NOW - 10,
      mainAgent: { state: 'done', outcome: 'failure' }
    } as Partial<AgentStatusEntry>)
    expect(hasActivityInboxAgentAttention(source({ a: failed }), NOW)).toBe(true)
    expect(hasActivityInboxAgentAttention(source({ a: failed }, { acked: { a: NOW } }), NOW)).toBe(
      false
    )
  })

  it('ignores a migration-blocked pane with no Activity row', () => {
    const blocked = {
      ...source({}),
      migrationUnsupportedByPtyId: {
        pty: {
          ptyId: 'pty',
          paneKey: 'gone:leaf',
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: NOW
        }
      }
    } as Parameters<typeof hasActivityInboxAgentAttention>[0]
    expect(hasActivityInboxAgentAttention(blocked, NOW)).toBe(false)
  })

  it('ignores panes with no Activity row', () => {
    expect(hasActivityInboxAgentAttention(source({ a: entry() }, { rows: [] }), NOW)).toBe(false)
  })

  it('ignores a session boundary, which has no row to clear', () => {
    expect(
      hasActivityInboxAgentAttention(source({ a: entry({ sessionBoundary: true }) }), NOW)
    ).toBe(false)
  })
})

function thread(overrides: Partial<AgentPaneThread>): AgentPaneThread {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: activityInboxKind reads migration and the status fields only.
  return { paneKey: 'a', unread: false, ...overrides } as AgentPaneThread
}

describe('activityInboxKind', () => {
  it('leaves running work out, even with an unread outcome from an earlier turn', () => {
    const working = {
      currentAgentState: 'working' as const,
      currentAgentEntry: entry({ state: 'working' })
    }
    expect(activityInboxKind(thread(working))).toBeNull()
    expect(activityInboxKind(thread({ ...working, unread: true }))).toBeNull()
  })

  it('lists an agent waiting on you as an ask', () => {
    expect(
      activityInboxKind(
        thread({ currentAgentState: 'waiting', currentAgentEntry: entry({ state: 'waiting' }) })
      )
    ).toBe('ask')
  })

  it('drops a stale wait you have read, and keeps one you have not', () => {
    const stale = { paneEntry: entry({ state: 'waiting' }) }
    expect(activityInboxKind(thread(stale))).toBeNull()
    expect(activityInboxKind(thread({ ...stale, unread: true }))).toBe('ask')
  })

  it('lists a finished turn as an outcome', () => {
    expect(activityInboxKind(thread({ paneEntry: entry({ state: 'done' }) }))).toBe('outcome')
  })

  it('never lists a dispatched child worker', () => {
    const orchestration = { taskId: 't', dispatchId: 'd' }
    expect(
      activityInboxKind(
        thread({
          currentAgentState: 'waiting',
          currentAgentEntry: entry({ state: 'waiting', orchestration })
        })
      )
    ).toBeNull()
  })

  it('lists a blocked migration as an ask', () => {
    expect(activityInboxKind(thread({ migrationUnsupportedPtyId: 'pty' }))).toBe('ask')
  })
})
