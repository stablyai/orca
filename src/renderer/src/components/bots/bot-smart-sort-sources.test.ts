import { expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { buildAttentionByWorktree } from '../../../../shared/sidebar-list/sorting/smart-attention-scan'
import { botSmartSortSources } from './bot-smart-sort-sources'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const NOW = 2_000_000_000_000
const STALE = NOW - 31 * 60_000
const GEMINI_PERMISSION = '✋  Action Required (orca)'.padEnd(80, ' ')

const leaf = (leafId: string) => ({ type: 'leaf' as const, leafId })
const split = (first: string, second: string) => ({
  root: {
    type: 'split' as const,
    direction: 'horizontal' as const,
    first: leaf(first),
    second: leaf(second)
  },
  activeLeafId: first,
  expandedLeafId: null
})

function hook(paneKey: string, updatedAt: number, worktreeId?: string): AgentStatusEntry {
  return {
    ...(worktreeId ? { worktreeId } : {}),
    paneKey,
    state: 'working',
    prompt: 'Task',
    updatedAt,
    stateStartedAt: updatedAt,
    stateHistory: []
  }
}

/** One workspace per case, each with one terminal tab whose PTY is live. */
const CASES = {
  // Parked split terminals publish negative title slots.
  parked: {
    layout: split(A, B),
    titles: { [-1]: 'zsh', [-2]: GEMINI_PERMISSION },
    hooks: [hook(`tab-parked:${B}`, STALE)],
    cls: 1
  },
  // Closing the middle pane leaves a gap in the title slots.
  sparse: {
    layout: split(A, C),
    titles: { 1: 'zsh', 3: GEMINI_PERMISSION },
    hooks: [hook(`tab-sparse:${C}`, STALE)],
    cls: 1
  },
  staleHookPermission: {
    layout: { root: leaf(A), activeLeafId: A, expandedLeafId: null },
    titles: { 1: GEMINI_PERMISSION },
    hooks: [hook(`tab-staleHookPermission:${A}`, STALE)],
    cls: 1
  },
  // A hand-started agent in a split names no agent in its title and sends no hook.
  identityLess: {
    layout: split(A, B),
    titles: { 1: '◐ Say hi in one word', 2: 'zsh' },
    hooks: [],
    cls: 3
  },
  // A hook stamped with its workspace; once its tab leaves the mirror it counts on its own.
  attributed: {
    layout: { root: leaf(A), activeLeafId: A, expandedLeafId: null },
    titles: {},
    hooks: [hook(`tab-attributed:${A}`, NOW, 'attributed')],
    cls: 3
  }
} as const

type CaseName = keyof typeof CASES
const NAMES: CaseName[] = ['parked', 'sparse', 'staleHookPermission', 'identityLess', 'attributed']

function fleetState(hookUpdatedAt?: number): AppState {
  const names = NAMES
  const rows = new Map<string, AgentStatusEntry>()
  for (const name of names) {
    for (const entry of CASES[name].hooks) {
      rows.set(entry.paneKey, hookUpdatedAt ? { ...entry, updatedAt: hookUpdatedAt } : entry)
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the Smart scan reads only these fields.
  return {
    tabsByWorktree: Object.fromEntries(
      names.map((name) => [name, [{ id: `tab-${name}`, title: 'Terminal' }]])
    ),
    ptyIdsByTabId: Object.fromEntries(names.map((name) => [`tab-${name}`, ['pty']])),
    runtimePaneTitlesByTabId: Object.fromEntries(
      names.map((name) => [`tab-${name}`, CASES[name].titles])
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      names.map((name) => [`tab-${name}`, CASES[name].layout])
    ),
    agentStatusByPaneKey: rows,
    migrationUnsupportedByPtyId: {}
  } as unknown as AppState
}

function compare(state: AppState) {
  const worktrees = NAMES.map((id) => ({ id, lastActivityAt: 0 }))
  const uncached = buildAttentionByWorktree(
    worktrees,
    state.tabsByWorktree,
    state.agentStatusByPaneKey,
    state.runtimePaneTitlesByTabId,
    state.ptyIdsByTabId,
    NOW,
    state.migrationUnsupportedByPtyId,
    state.terminalLayoutsByTabId
  )
  const sources = botSmartSortSources(state)
  return worktrees.map((worktree) => ({
    id: worktree.id,
    cached: sources.attentionForWorktree!(worktree, NOW),
    uncached: uncached.get(worktree.id)
  }))
}

it('resolves each bot workspace exactly as the uncached Smart scan does', () => {
  for (const row of compare(fleetState())) {
    expect(row.cached).toEqual(row.uncached)
    expect(row.cached.cls).toBe(CASES[row.id].cls)
  }
})

it('rebuilds the shared lookups when any one input changes', () => {
  const base = fleetState()
  compare(base)
  // A fresh hook covers its own pane's title, so the single-pane permission worker drops to working.
  const freshStatuses = compare({
    ...base,
    agentStatusByPaneKey: fleetState(NOW).agentStatusByPaneKey
  })
  // With its tab gone, the stamped hook is no longer filtered as mirrored; a stale lookup would leave it idle.
  const fewerTabs = compare({
    ...base,
    tabsByWorktree: Object.fromEntries(
      Object.entries(base.tabsByWorktree).filter(([id]) => id !== 'attributed')
    )
  })
  // A migration block on the hand-started agent's pane asks for the user.
  const blocked = compare({
    ...base,
    migrationUnsupportedByPtyId: {
      pty: {
        ptyId: 'pty',
        paneKey: `tab-identityLess:${A}`,
        reason: 'legacy-numeric-pane-key',
        source: 'local',
        updatedAt: NOW
      }
    }
  })
  for (const row of [...freshStatuses, ...fewerTabs, ...blocked]) {
    expect(row.cached).toEqual(row.uncached)
  }
  const cls = (rows: ReturnType<typeof compare>, id: string) =>
    rows.find((row) => row.id === id)?.cached.cls
  expect(cls(freshStatuses, 'staleHookPermission')).toBe(3)
  expect(cls(fewerTabs, 'attributed')).toBe(3)
  expect(cls(blocked, 'identityLess')).toBe(1)
})
