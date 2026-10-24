import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../../shared/terminal-tab-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { collectLeafIds } from '../../../shared/terminal-pane-layout-tree'
import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '../store/slices/store-test-helpers'
import { classifyPaneKeyLiveness } from '../store/slices/agent-status-capacity-eviction'
import {
  resetAgentPaneAuthorityAliasesForTests,
  resolveAgentPaneAuthorityKey
} from '../store/slices/agent-pane-authority'
import { buildWindowApi } from './ipc-events-agent-status-window-test-fixtures'
import type { AgentStatusSetData } from './ipc-events-agent-status-store-test-fixtures'

const holder = vi.hoisted(() => ({
  getStore: (): ReturnType<typeof createTestStore> => {
    throw new Error('Witness store not initialized')
  }
}))
vi.mock('../store', () => ({
  useAppStore: {
    getState: () => holder.getStore().getState(),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      holder.getStore().subscribe(...args)
  }
}))
vi.mock('./agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))
vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const R = '33333333-3333-4333-8333-333333333333'
const TAB = 'tab-ordering'
const WT = 'wt-ordering'
const key = (leaf: string): string => makePaneKey(TAB, leaf)
const layout = (...leaves: string[]): TerminalLayoutSnapshot => ({
  root: leaves.slice(1).reduce<TerminalPaneLayoutNode>(
    (first, leafId) => ({
      type: 'split',
      direction: 'vertical',
      first,
      second: { type: 'leaf', leafId }
    }),
    { type: 'leaf', leafId: leaves[0]! }
  ),
  activeLeafId: leaves[0]!,
  expandedLeafId: null
})
const cleanups: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  resetAgentPaneAuthorityAliasesForTests()
})
afterEach(() => {
  cleanups
    .splice(0)
    .toReversed()
    .forEach((cleanup) => cleanup())
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function witness() {
  const store = createTestStore()
  holder.getStore = () => store
  const tab = makeTab({ id: TAB, worktreeId: WT, ptyId: 'pty-A', title: 'Shell' })
  store.setState({
    workspaceSessionReady: true,
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: WT, repoId: TEST_REPO.id })] },
    tabsByWorktree: { [WT]: [tab] },
    terminalLayoutsByTabId: { [TAB]: layout(R) }
  })
  let phase = 'mount'
  const publications: unknown[] = []
  const removals: { phase: string; incoming: string; keys: string[]; owner: string }[] = []
  const capture = (): void => {
    const state = store.getState()
    publications.push({
      phase,
      layouts: state.terminalLayoutsByTabId,
      aliases: [A, B, R].map((leaf) => [key(leaf), resolveAgentPaneAuthorityKey(key(leaf))]),
      projection: state.agentConversationsByPaneKey,
      live: Object.keys(state.agentStatusByPaneKey),
      sleeping: Object.keys(state.sleepingAgentSessionsByPaneKey)
    })
  }
  cleanups.push(
    store.subscribe((state, previous) => {
      capture()
      for (const incoming of [key(A), key(B)]) {
        if (
          state.agentConversationsByPaneKey[incoming] &&
          !previous.agentConversationsByPaneKey[incoming]
        ) {
          // Observational only: exercise the candidate's classifier, never remove a production key.
          const classify = classifyPaneKeyLiveness(state)
          removals.push({
            phase,
            incoming,
            owner: resolveAgentPaneAuthorityKey(key(A)),
            keys: Object.keys(state.agentConversationsByPaneKey).filter(
              (candidate) => candidate !== incoming && classify(candidate) === 'dead'
            )
          })
        }
      }
    })
  )
  let onSet: ((data: AgentStatusSetData) => void) | undefined
  vi.stubGlobal(
    'window',
    buildWindowApi({
      onSet: (callback) => {
        onSet = callback
        return () => {}
      }
    })
  )
  const { registerAgentStatusIpcBridge } = await import('./ipc-events/agent-status-ipc-bridge')
  const unsubs: (() => void)[] = []
  const bridge = registerAgentStatusIpcBridge(unsubs)
  cleanups.push(bridge.disposeAsyncState, bridge.unsubscribeStore, ...unsubs)
  await Promise.resolve()
  const transaction = vi.spyOn(store.getState(), 'transactAgentStatuses')
  const timer = vi.spyOn(globalThis, 'setTimeout')
  const event = (
    leaf: string,
    providerSessionOnly = false,
    runtimeBacked = true
  ): AgentStatusIpcPayload & AgentStatusSetData => ({
    paneKey: key(leaf),
    connectionId: null,
    state: 'working',
    prompt: '',
    agentType: 'claude',
    receivedAt: Date.now(),
    stateStartedAt: Date.now(),
    providerSession: { key: 'session_id', id: `conversation-${leaf}` },
    ...(providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...(runtimeBacked ? { worktreeId: WT, terminalHandle: `term-${leaf}` } : {})
  })
  return {
    store,
    tab,
    publications,
    removals,
    transaction,
    timer,
    event,
    stage: (name: string) => {
      phase = name
      capture()
    },
    emit: (data: ReturnType<typeof event>) => {
      if (!onSet) {
        throw new Error('Missing production onSet')
      }
      onSet(data)
    },
    settle: async () => {
      await vi.advanceTimersByTimeAsync(150)
      phase = 'settled'
      capture()
    }
  }
}

it.each([
  ['live', A, B],
  ['live', B, A],
  ['provider-only', A, B],
  ['provider-only', B, A]
])(
  'preserves two %s source-before-layout identities in order %s then %s',
  async (route, first, second) => {
    const w = await witness()
    for (const leaf of [first, second]) {
      w.stage(`source-${leaf}`)
      w.emit(w.event(leaf, route === 'provider-only'))
      await vi.advanceTimersByTimeAsync(34)
    }
    expect(w.removals.at(-1)?.keys).toEqual([key(first)])
    for (const leaf of [A, B]) {
      w.stage(`ordinary-cleanup-${leaf}`)
      w.store.getState().removeAgentStatus(key(leaf))
      w.store.getState().clearSleepingAgentSession(key(leaf))
    }
    expect(w.store.getState().agentStatusByPaneKey).toEqual({})
    expect(w.store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    w.stage('later-layout')
    w.store.getState().setTabLayout(TAB, layout(A, B))
    await w.settle()
    expect(Object.keys(w.store.getState().agentConversationsByPaneKey).sort()).toEqual(
      [key(A), key(B)].sort()
    )
    console.info(
      'OWNER_ORDERING_TRACE',
      JSON.stringify({
        route,
        first,
        second,
        publications: w.publications,
        wouldRemove: w.removals
      })
    )
  }
)

it.each(['normalization', 'scoped-hydration'])(
  'replays pending B before projection-only A transfers during %s',
  async (operation) => {
    const w = await witness()
    w.store.getState().setTabLayout(TAB, layout(A))
    w.stage('source-A')
    w.emit(w.event(A, true))
    w.store.getState().clearSleepingAgentSession(key(A))
    expect(w.store.getState().agentStatusByPaneKey).toEqual({})
    expect(w.store.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    await vi.advanceTimersByTimeAsync(34)
    w.stage('pending-B')
    w.emit(w.event(B, false, false))
    expect(w.store.getState().agentConversationsByPaneKey[key(B)]).toBeUndefined()
    expect(w.timer.mock.calls.filter((call) => call[1] === 100)).toHaveLength(1)
    const batchesBefore = w.transaction.mock.calls.length
    const duplicate = {
      ...layout(A, R, B),
      activeLeafId: R,
      ptyIdsByLeafId: { [A]: 'pty-A', [R]: 'pty-A', [B]: 'pty-B' }
    }
    w.stage(operation)
    if (operation === 'normalization') {
      w.store.getState().setTabLayout(TAB, duplicate)
    } else {
      w.store.getState().hydrateWorkspaceSession(
        {
          ...getDefaultWorkspaceSession(),
          activeRepoId: TEST_REPO.id,
          activeWorktreeId: WT,
          activeTabId: TAB,
          tabsByWorktree: { [WT]: [w.tab] },
          terminalLayoutsByTabId: { [TAB]: duplicate }
        },
        { replaceWorkspaceKeys: [WT] }
      )
    }
    expect(w.transaction.mock.calls.length - batchesBefore).toBe(1)
    expect(w.removals.find((row) => row.incoming === key(B))).toEqual({
      phase: operation,
      incoming: key(B),
      owner: key(A),
      keys: [key(A)]
    })
    expect(collectLeafIds(w.store.getState().terminalLayoutsByTabId[TAB].root)).toEqual([R, B])
    expect(resolveAgentPaneAuthorityKey(key(A))).toBe(key(R))
    expect(w.store.getState().agentConversationsByPaneKey[key(R)]?.providerSession.id).toBe(
      `conversation-${A}`
    )
    expect(w.store.getState().agentConversationsByPaneKey[key(A)]).toBeUndefined()
    await w.settle()
    expect(w.store.getState().agentConversationsByPaneKey[key(B)]).toBeDefined()
    expect(w.store.getState().agentConversationsByPaneKey[key(R)]).toBeDefined()
    console.info(
      'OWNER_ORDERING_TRACE',
      JSON.stringify({
        operation,
        synchronousPendingBatches: w.transaction.mock.calls.length - batchesBefore,
        pendingRetryTimers: w.timer.mock.calls.filter((call) => call[1] === 100).length,
        publications: w.publications,
        wouldRemove: w.removals
      })
    )
  }
)
