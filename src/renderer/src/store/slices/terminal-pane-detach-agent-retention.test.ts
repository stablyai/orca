import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { collectRetainedAgentsOnDisappear } from '@/components/dashboard/useRetainedAgents'
import {
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey
} from './agent-pane-authority'
import { createTestStore, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { TerminalTab } from '../../../../shared/types'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'

const WORKTREE_ID = 'repo::/repo/worktree'
const SOURCE_TAB = 'tab-source'
const TARGET_TAB = 'tab-target'
const FINAL_TAB = 'tab-final'
const LEAF = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF = '22222222-2222-4222-8222-222222222222'
const SOURCE_PANE_KEY = makePaneKey(SOURCE_TAB, LEAF)
const TARGET_PANE_KEY = makePaneKey(TARGET_TAB, LEAF)
const FINAL_PANE_KEY = makePaneKey(FINAL_TAB, LEAF)

beforeEach(() => {
  resetAgentPaneAuthorityAliasesForTests()
})

afterEach(() => {
  resetAgentPaneAuthorityAliasesForTests()
})

function makeDoneEntry(args: {
  paneKey: string
  tabId: string
  startedAt: number
  agentType: AgentStatusEntry['agentType']
  terminalHandle?: string
  providerSession?: AgentStatusEntry['providerSession']
}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Fix it',
    updatedAt: args.startedAt,
    stateStartedAt: args.startedAt,
    paneKey: args.paneKey,
    tabId: args.tabId,
    terminalTitle: 'Claude',
    stateHistory: [],
    agentType: args.agentType,
    terminalHandle: args.terminalHandle,
    providerSession: args.providerSession,
    interrupted: false
  }
}

function makeRow(
  paneKey: string,
  tabId: string,
  startedAt = 100,
  overrides?: {
    agentType?: AgentStatusEntry['agentType']
    terminalHandle?: string
    providerSession?: AgentStatusEntry['providerSession']
  }
): DashboardAgentRow {
  const agentType = overrides?.agentType ?? 'claude'
  return {
    paneKey,
    entry: makeDoneEntry({
      paneKey,
      tabId,
      startedAt,
      agentType,
      terminalHandle: overrides?.terminalHandle,
      providerSession: overrides?.providerSession
    }),
    tab: makeTab({ id: tabId, worktreeId: WORKTREE_ID }),
    agentType,
    state: 'done',
    startedAt
  }
}

function createDetachStore() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo', path: '/repo/worktree' })]
    },
    tabsByWorktree: {
      [WORKTREE_ID]: [
        makeTab({ id: SOURCE_TAB, worktreeId: WORKTREE_ID, ptyId: 'pty-a' }),
        makeTab({ id: TARGET_TAB, worktreeId: WORKTREE_ID, ptyId: null }),
        makeTab({ id: FINAL_TAB, worktreeId: WORKTREE_ID, ptyId: null })
      ]
    },
    ptyIdsByTabId: {
      [SOURCE_TAB]: ['pty-a', 'pty-sibling'],
      [TARGET_TAB]: [],
      [FINAL_TAB]: []
    }
  })
  return store
}

function detach(
  store: ReturnType<typeof createDetachStore>,
  sourceTabId: string,
  targetTabId: string
) {
  store.getState().syncPaneDetachPtyOwnership({
    detachedLeafId: LEAF,
    detachedPtyId: 'pty-a',
    sourceLayout: {
      root: { type: 'leaf', leafId: SIBLING_LEAF },
      activeLeafId: SIBLING_LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [SIBLING_LEAF]: 'pty-sibling' }
    },
    sourceTabId,
    targetTabId
  })
}

function collect(args: {
  currentPaneKey?: string
  currentTabId?: string
  currentStartedAt?: number
  currentAgentType?: AgentStatusEntry['agentType']
  terminalHandle?: string
  previousProviderSession?: AgentStatusEntry['providerSession']
  currentProviderSession?: AgentStatusEntry['providerSession']
  retiredPaneKeys?: Record<string, true>
  tabIndex?: Map<string, { tab: TerminalTab }>
}) {
  return collectRetainedAgentsOnDisappear({
    previousAgents: new Map([
      [
        SOURCE_PANE_KEY,
        {
          row: makeRow(SOURCE_PANE_KEY, SOURCE_TAB, 100, {
            terminalHandle: args.terminalHandle,
            providerSession: args.previousProviderSession
          }),
          worktreeId: WORKTREE_ID
        }
      ]
    ]),
    currentAgents:
      args.currentPaneKey && args.currentTabId
        ? new Map([
            [
              args.currentPaneKey,
              {
                row: makeRow(args.currentPaneKey, args.currentTabId, args.currentStartedAt, {
                  agentType: args.currentAgentType,
                  terminalHandle: args.terminalHandle,
                  providerSession: args.currentProviderSession
                }),
                worktreeId: WORKTREE_ID
              }
            ]
          ])
        : new Map(),
    retainedAgentsByPaneKey: {},
    retentionSuppressedPaneKeys: {},
    recentlyClosedAgentStatusTabIds: {},
    recentlyRetiredAgentStatusPaneKeys: args.retiredPaneKeys ?? {},
    tabIndex: args.tabIndex
  })
}

describe('detach completed split pane → sidebar retention', () => {
  it('recognizes the same run at its transferred authority without a suppressor', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    const state = store.getState()
    const result = collect({ currentPaneKey: TARGET_PANE_KEY, currentTabId: TARGET_TAB })

    expect(state.agentStatusByPaneKey[SOURCE_PANE_KEY]).toBeUndefined()
    expect(state.agentStatusByPaneKey[TARGET_PANE_KEY]?.state).toBe('done')
    expect(state.retentionSuppressedPaneKeys[SOURCE_PANE_KEY]).toBeUndefined()
    expect(result.toRetain).toEqual([])
    expect(result.consumedSuppressedPaneKeys).toEqual([])
  })

  it('recognizes the same run after chained transfers', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    detach(store, TARGET_TAB, FINAL_TAB)

    expect(collect({ currentPaneKey: FINAL_PANE_KEY, currentTabId: FINAL_TAB }).toRetain).toEqual(
      []
    )
    // Why: every intermediate key must resolve to the CURRENT owner, not the previous hop.
    expect(resolveAgentPaneAuthorityKey(SOURCE_PANE_KEY)).toBe(FINAL_PANE_KEY)
    expect(resolveAgentPaneAuthorityKey(TARGET_PANE_KEY)).toBe(FINAL_PANE_KEY)
  })

  it('keeps every intermediate key routed after a fourth move', () => {
    const store = createDetachStore()
    const EXTRA_TAB = 'tab-extra'
    const extraPaneKey = makePaneKey(EXTRA_TAB, LEAF)
    store.setState({
      tabsByWorktree: {
        [WORKTREE_ID]: [
          ...(store.getState().tabsByWorktree[WORKTREE_ID] ?? []),
          makeTab({ id: EXTRA_TAB, worktreeId: WORKTREE_ID, ptyId: null })
        ]
      }
    })
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    detach(store, TARGET_TAB, FINAL_TAB)
    detach(store, FINAL_TAB, EXTRA_TAB)

    for (const formerKey of [SOURCE_PANE_KEY, TARGET_PANE_KEY, FINAL_PANE_KEY]) {
      expect(resolveAgentPaneAuthorityKey(formerKey)).toBe(extraPaneKey)
    }
    store.getState().setAgentStatus(TARGET_PANE_KEY, { state: 'done', prompt: 'late post' })
    expect(store.getState().agentStatusByPaneKey[extraPaneKey]?.prompt).toBe('late post')
  })

  it('still retains the source when a different run occupies the transferred key', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    const result = collect({
      currentPaneKey: TARGET_PANE_KEY,
      currentTabId: TARGET_TAB,
      currentStartedAt: 900
    })

    expect(result.toRetain).toHaveLength(1)
    expect(result.toRetain[0]?.entry.paneKey).toBe(SOURCE_PANE_KEY)
  })

  it('still retains when a new agent reuses the pty and inherits its terminal handle', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    // Why: terminalHandle is pty-scoped, so a fresh codex run carries the same handle.
    const result = collect({
      currentPaneKey: TARGET_PANE_KEY,
      currentTabId: TARGET_TAB,
      currentStartedAt: 900,
      currentAgentType: 'codex',
      terminalHandle: 'term_shared'
    })

    expect(result.toRetain).toHaveLength(1)
    expect(result.toRetain[0]?.entry.paneKey).toBe(SOURCE_PANE_KEY)
  })

  it('treats differing terminal handles as different runs', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    // Why: identical startedAt/agentType can collide, so a differing handle is the
    // only signal that these are separate terminals.
    const result = collectRetainedAgentsOnDisappear({
      previousAgents: new Map([
        [
          SOURCE_PANE_KEY,
          {
            row: makeRow(SOURCE_PANE_KEY, SOURCE_TAB, 100, { terminalHandle: 'term_source' }),
            worktreeId: WORKTREE_ID
          }
        ]
      ]),
      currentAgents: new Map([
        [
          TARGET_PANE_KEY,
          {
            row: makeRow(TARGET_PANE_KEY, TARGET_TAB, 100, { terminalHandle: 'term_other' }),
            worktreeId: WORKTREE_ID
          }
        ]
      ]),
      retainedAgentsByPaneKey: {},
      retentionSuppressedPaneKeys: {},
      recentlyClosedAgentStatusTabIds: {},
      recentlyRetiredAgentStatusPaneKeys: {}
    })

    expect(result.toRetain).toHaveLength(1)
  })

  it('recognizes the same run when resume identity lands only after the move', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    // Why: recordAgentProviderSession is its own IPC event, so the destination can be
    // stamped while the pre-move snapshot is not. A one-sided session is not evidence
    // of a different run.
    const result = collect({
      currentPaneKey: TARGET_PANE_KEY,
      currentTabId: TARGET_TAB,
      currentProviderSession: { key: 'session_id', id: 'session-1' }
    })

    expect(result.toRetain).toEqual([])
  })

  it('treats mismatched resume identities as different runs', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    const result = collect({
      currentPaneKey: TARGET_PANE_KEY,
      currentTabId: TARGET_TAB,
      previousProviderSession: { key: 'session_id', id: 'session-1' },
      currentProviderSession: { key: 'session_id', id: 'session-2' }
    })

    expect(result.toRetain).toHaveLength(1)
  })

  it('recognizes a handle-less local pty run at its transferred authority', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    // Why: ordinary local PTY statuses route with connectionId only, so terminalHandle
    // is undefined on both sides — requiring a handle here would resurrect the ghost.
    const result = collect({ currentPaneKey: TARGET_PANE_KEY, currentTabId: TARGET_TAB })

    expect(result.toRetain[0]?.entry.terminalHandle).toBeUndefined()
    expect(result.toRetain).toEqual([])
  })

  it('does not resurrect the source when the transferred owner immediately closes', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    store.getState().dropAgentStatusByTabPrefix(TARGET_TAB)
    const retiredPaneKeys = store.getState().recentlyRetiredAgentStatusPaneKeys

    expect(retiredPaneKeys[SOURCE_PANE_KEY]).toBe(true)
    expect(retiredPaneKeys[TARGET_PANE_KEY]).toBe(true)
    expect(collect({ retiredPaneKeys }).toRetain).toEqual([])
  })

  it('retains at the transferred surface when the destination pty exits before the next sync', () => {
    const store = createDetachStore()
    store.getState().setAgentStatus(SOURCE_PANE_KEY, {
      state: 'done',
      prompt: 'Fix it',
      agentType: 'claude'
    })

    detach(store, SOURCE_TAB, TARGET_TAB)
    store.getState().removeAgentStatus(TARGET_PANE_KEY)

    // Why: the retention effect coalesced the move and the exit into one pass, so it
    // only ever sees the source key vanish.
    const destinationTab = makeTab({
      id: TARGET_TAB,
      worktreeId: WORKTREE_ID,
      title: 'Destination',
      launchAgent: 'codex'
    })
    const retained = collect({
      tabIndex: new Map([[TARGET_TAB, { tab: destinationTab }]])
    }).toRetain
    expect(retained).toHaveLength(1)
    expect(retained[0]?.entry.paneKey).toBe(TARGET_PANE_KEY)
    expect(retained[0]?.entry.tabId).toBe(TARGET_TAB)
    // Why: the row must carry the DESTINATION tab's identity, not the source tab's
    // title/launchAgent relabeled with a new id — sidebar agent-type resolution reads both.
    expect(retained[0]?.tab).toBe(destinationTab)
    expect(retained[0]?.tab.title).toBe('Destination')
  })

  it('does not create suppressors for a plain terminal detach', () => {
    const store = createDetachStore()

    detach(store, SOURCE_TAB, TARGET_TAB)

    expect(store.getState().retentionSuppressedPaneKeys[SOURCE_PANE_KEY]).toBeUndefined()
    expect(store.getState().retentionSuppressedPaneKeys[TARGET_PANE_KEY]).toBeUndefined()
  })
})
