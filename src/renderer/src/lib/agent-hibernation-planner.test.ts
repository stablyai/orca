import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import {
  DEFAULT_AGENT_HIBERNATION_IDLE_MS,
  MAX_AGENT_HIBERNATION_IDLE_MS,
  MIN_AGENT_HIBERNATION_IDLE_MS,
  confirmAgentHibernationCandidates,
  getEffectiveAgentHibernationIdleMs,
  planAgentHibernationCandidates,
  type AgentHibernationPlannerSnapshot
} from './agent-hibernation-planner'

const NOW = 2_000_000
const OLD = NOW - DEFAULT_AGENT_HIBERNATION_IDLE_MS - 1
const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'

function tab(id = 'tab-1', worktreeId = 'wt-bg'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'Agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function layout(leafId = LEAF, ptyId = 'pty-1'): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  const paneKey = overrides.paneKey ?? `tab-1:${LEAF}`
  return {
    state: 'done',
    prompt: 'make it so',
    updatedAt: OLD,
    stateStartedAt: OLD,
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-bg',
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'session-1' },
    stateHistory: [],
    ...overrides
  }
}

function snapshot(
  overrides: Partial<AgentHibernationPlannerSnapshot> = {}
): AgentHibernationPlannerSnapshot {
  const agentEntry = entry()
  return {
    settings: {
      experimentalAgentHibernation: true,
      agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
    },
    activeWorktreeId: 'wt-active',
    foregroundWorktreeIds: ['wt-active'],
    tabsByWorktree: { 'wt-bg': [tab()] },
    terminalLayoutsByTabId: { 'tab-1': layout() },
    ptyIdsByTabId: { 'tab-1': ['pty-1'] },
    mobileLockedPtyIds: [],
    agentStatusByPaneKey: { [agentEntry.paneKey]: agentEntry },
    sleepingAgentSessionsByPaneKey: {},
    lastTerminalInputAtByPaneKey: {},
    now: NOW,
    ...overrides
  }
}

function plannedWorktrees(input: AgentHibernationPlannerSnapshot): string[] {
  return planAgentHibernationCandidates(input).map((candidate) => candidate.worktreeId)
}

describe('agent hibernation planner', () => {
  it('selects nothing when disabled, active, or foreground', () => {
    expect(
      plannedWorktrees(
        snapshot({
          settings: {
            experimentalAgentHibernation: false,
            agentHibernationIdleMs: DEFAULT_AGENT_HIBERNATION_IDLE_MS
          }
        })
      )
    ).toEqual([])
    expect(plannedWorktrees(snapshot({ activeWorktreeId: 'wt-bg' }))).toEqual([])
    expect(plannedWorktrees(snapshot({ foregroundWorktreeIds: ['wt-active', 'wt-bg'] }))).toEqual(
      []
    )
  })

  it('requires done resumable provider-session entries', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      const e = entry({ state })
      expect(plannedWorktrees(snapshot({ agentStatusByPaneKey: { [e.paneKey]: e } }))).toEqual([])
    }
    const noSession = entry({ providerSession: undefined })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [noSession.paneKey]: noSession } }))
    ).toEqual([])
    const unsupported = entry({ agentType: 'amp' })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [unsupported.paneKey]: unsupported } }))
    ).toEqual([])
  })

  it('requires the idle threshold and blocks input after done', () => {
    const fresh = entry({ updatedAt: NOW - 1_000 })
    expect(
      plannedWorktrees(snapshot({ agentStatusByPaneKey: { [fresh.paneKey]: fresh } }))
    ).toEqual([])
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD + 1 } }))
    ).toEqual([])
    expect(
      plannedWorktrees(snapshot({ lastTerminalInputAtByPaneKey: { [`tab-1:${LEAF}`]: OLD } }))
    ).toEqual(['wt-bg'])
  })

  it('rejects untracked live PTYs and already-sleeping panes', () => {
    expect(
      plannedWorktrees(snapshot({ ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-shell'] } }))
    ).toEqual([])
    expect(plannedWorktrees(snapshot({ ptyIdsByTabId: { 'tab-1': [] } }))).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({ sleepingAgentSessionsByPaneKey: { [`tab-1:${LEAF}`]: {} as never } })
      )
    ).toEqual([])
  })

  it('rejects mobile-driven panes because paired clients can send input outside desktop xterm', () => {
    expect(plannedWorktrees(snapshot({ mobileLockedPtyIds: ['pty-1'] }))).toEqual([])
  })

  it('selects runtime-backed live PTYs when the renderer live map is empty', () => {
    const [candidate] = planAgentHibernationCandidates(
      snapshot({
        ptyIdsByTabId: { 'tab-1': [] },
        runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['pty-1'] },
        runtimeLivenessRequiredWorktreeIds: ['wt-bg']
      })
    )

    expect(candidate).toMatchObject({
      worktreeId: 'wt-bg',
      paneKeys: [`tab-1:${LEAF}`],
      expectedRuntimePtyIds: ['pty-1']
    })
  })

  it('matches wrapped remote renderer PTY IDs to raw runtime PTY IDs', () => {
    const [candidate] = planAgentHibernationCandidates(
      snapshot({
        terminalLayoutsByTabId: { 'tab-1': layout(LEAF, 'remote:env-1@@terminal-1') },
        ptyIdsByTabId: { 'tab-1': ['remote:env-1@@terminal-1'] },
        runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['terminal-1'] },
        runtimeLivenessRequiredWorktreeIds: ['wt-bg']
      })
    )

    expect(candidate).toMatchObject({
      worktreeId: 'wt-bg',
      paneKeys: [`tab-1:${LEAF}`],
      expectedRuntimePtyIds: ['terminal-1']
    })
  })

  it('does not select layout-only stale PTYs without runtime liveness', () => {
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': [] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': ['pty-1'] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': [] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([])
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([])
  })

  it('rejects runtime-backed worktrees with extra unknown live PTYs', () => {
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['pty-1', 'pty-shell'] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg']
        })
      )
    ).toEqual([])
  })

  it('applies mobile locks to runtime-backed PTYs', () => {
    expect(
      plannedWorktrees(
        snapshot({
          ptyIdsByTabId: { 'tab-1': [] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['pty-1'] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg'],
          mobileLockedPtyIds: ['pty-1']
        })
      )
    ).toEqual([])
  })

  it('applies mobile locks across wrapped remote and raw runtime PTY IDs', () => {
    expect(
      plannedWorktrees(
        snapshot({
          terminalLayoutsByTabId: { 'tab-1': layout(LEAF, 'remote:env-1@@terminal-1') },
          ptyIdsByTabId: { 'tab-1': ['remote:env-1@@terminal-1'] },
          runtimeLivePtyIdsByWorktreeId: { 'wt-bg': ['terminal-1'] },
          runtimeLivenessRequiredWorktreeIds: ['wt-bg'],
          mobileLockedPtyIds: ['remote:env-1@@terminal-1']
        })
      )
    ).toEqual([])
  })

  it('selects a worktree when all live PTYs are eligible done agents', () => {
    expect(plannedWorktrees(snapshot())).toEqual(['wt-bg'])
    const second = entry({
      paneKey: `tab-1:${OTHER_LEAF}`,
      providerSession: { key: 'session_id', id: 'session-2' }
    })
    expect(
      plannedWorktrees(
        snapshot({
          terminalLayoutsByTabId: {
            'tab-1': {
              root: {
                type: 'split',
                direction: 'horizontal',
                first: { type: 'leaf', leafId: LEAF },
                second: { type: 'leaf', leafId: OTHER_LEAF }
              },
              activeLeafId: LEAF,
              expandedLeafId: null,
              ptyIdsByLeafId: { [LEAF]: 'pty-1', [OTHER_LEAF]: 'pty-2' }
            }
          },
          ptyIdsByTabId: { 'tab-1': ['pty-1', 'pty-2'] },
          agentStatusByPaneKey: { [`tab-1:${LEAF}`]: entry(), [second.paneKey]: second }
        })
      )
    ).toEqual(['wt-bg'])
  })

  it('requires two stable ticks and resets on signature changes', () => {
    const [candidate] = planAgentHibernationCandidates(snapshot())
    const first = confirmAgentHibernationCandidates({}, [candidate])
    expect(first.candidates).toEqual([])
    expect(
      confirmAgentHibernationCandidates(first.confirmationState, [candidate]).candidates
    ).toEqual([candidate])
    const changed = { ...candidate, signature: `${candidate.signature}:changed` }
    expect(
      confirmAgentHibernationCandidates(first.confirmationState, [changed]).candidates
    ).toEqual([])
  })

  it('clamps corrupt or out-of-range idle durations to the default', () => {
    expect(getEffectiveAgentHibernationIdleMs(0)).toBe(DEFAULT_AGENT_HIBERNATION_IDLE_MS)
    expect(getEffectiveAgentHibernationIdleMs(Number.NaN)).toBe(DEFAULT_AGENT_HIBERNATION_IDLE_MS)
    expect(getEffectiveAgentHibernationIdleMs(MIN_AGENT_HIBERNATION_IDLE_MS - 1)).toBe(
      DEFAULT_AGENT_HIBERNATION_IDLE_MS
    )
    expect(getEffectiveAgentHibernationIdleMs(MAX_AGENT_HIBERNATION_IDLE_MS + 1)).toBe(
      DEFAULT_AGENT_HIBERNATION_IDLE_MS
    )
    expect(getEffectiveAgentHibernationIdleMs(MIN_AGENT_HIBERNATION_IDLE_MS)).toBe(
      MIN_AGENT_HIBERNATION_IDLE_MS
    )
    expect(getEffectiveAgentHibernationIdleMs(DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1)).toBe(
      DEFAULT_AGENT_HIBERNATION_IDLE_MS + 1
    )
  })
})
