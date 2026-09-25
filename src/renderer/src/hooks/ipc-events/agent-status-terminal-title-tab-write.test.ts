import { afterEach, describe, expect, it, vi } from 'vitest'
import type { useAppStore } from '@/store'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { resolveAgentStatusTerminalTitle } from '@/lib/agent-status-terminal-title'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { buildWindowApi } from '../ipc-events-agent-status-window-test-fixtures'
import type { AgentStatusSetData } from '../ipc-events-agent-status-store-test-fixtures'
import { resolvePaneKey, shouldApplyResolvedAgentTerminalTitleToTab } from './agent-status-routing'

vi.mock('../agent-hook-completion-notifications', () => ({
  observeAgentHookCompletionForNotification: vi.fn(),
  syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
}))

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKTREE_ID = 'repo-1::/wt-1'
const PANE_KEY = makePaneKey(TAB_ID, LEAF_ID)

/**
 * The two title slots this path straddles: `tab.title` (what it writes) and the layout's
 * `titlesByLeafId` (what only a mounted pane updates). They diverge whenever a hook-driven write
 * lands while the pane is unmounted.
 */
function storeWithDivergedTitleSlots(args: {
  tabTitle: string
  paneSlotTitle: string
}): ReturnType<typeof useAppStore.getState> {
  const tab: TerminalTab = {
    id: TAB_ID,
    ptyId: `pty-${TAB_ID}`,
    worktreeId: WORKTREE_ID,
    title: args.tabTitle,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
  return {
    tabsByWorktree: { [WORKTREE_ID]: [tab] },
    unifiedTabsByWorktree: {},
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        titlesByLeafId: { [LEAF_ID]: args.paneSlotTitle }
      }
    },
    worktreesByRepo: {},
    repos: []
  } as unknown as ReturnType<typeof useAppStore.getState>
}

describe('hook-driven tab title writes', () => {
  it('exposes the tab record title separately from the pane slot title', () => {
    const store = storeWithDivergedTitleSlots({
      tabTitle: 'Codex - action required',
      paneSlotTitle: 'Codex ready'
    })

    const resolved = resolvePaneKey(store, PANE_KEY)

    expect(resolved.title).toBe('Codex ready')
    expect(resolved.tabTitle).toBe('Codex - action required')
  })

  // Why: Orca writes "Codex - action required" itself on a blocked/waiting hook, into `tab.title`
  // only. When `done` arrived, the no-op guard compared the resolved title against the PANE slot —
  // which still read "Codex ready" — so the write was skipped and the tab kept asserting a question
  // the agent had already finished asking, for as long as the pane stayed unmounted.
  it('rewrites a stale action-required tab title once the agent reports done', () => {
    const store = storeWithDivergedTitleSlots({
      tabTitle: 'Codex - action required',
      paneSlotTitle: 'Codex ready'
    })
    const resolved = resolvePaneKey(store, PANE_KEY)
    const nextTitle = resolveAgentStatusTerminalTitle(
      { agentType: 'codex', state: 'done' },
      resolved.title
    )

    expect(nextTitle).toBe('Codex ready')
    // Comparing against the pane slot is what skipped the write.
    expect(
      shouldApplyResolvedAgentTerminalTitleToTab(store, PANE_KEY, resolved.title, nextTitle)
    ).toBe(false)
    // The tab record is the slot this path overwrites, so it is the one that decides.
    expect(
      shouldApplyResolvedAgentTerminalTitleToTab(store, PANE_KEY, resolved.tabTitle, nextTitle)
    ).toBe(true)
  })

  it('still skips the write when the tab record already holds the resolved title', () => {
    const store = storeWithDivergedTitleSlots({
      tabTitle: 'Codex ready',
      paneSlotTitle: 'Codex ready'
    })
    const resolved = resolvePaneKey(store, PANE_KEY)

    expect(
      shouldApplyResolvedAgentTerminalTitleToTab(store, PANE_KEY, resolved.tabTitle, 'Codex ready')
    ).toBe(false)
  })
})

describe('hook-driven tab title IPC integration', () => {
  afterEach(() => {
    vi.doUnmock('../../store')
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it.each([
    { mode: 'live', states: ['done'], title: 'Codex - action required', expected: 'Codex ready' },
    {
      mode: 'snapshot',
      states: ['waiting', 'done'],
      title: 'Codex ready',
      expected: 'Codex ready'
    },
    {
      mode: 'snapshot',
      states: ['done', 'waiting'],
      title: 'Codex ready',
      expected: 'Codex - action required'
    },
    {
      mode: 'inactive-pane',
      states: ['done'],
      title: 'Codex - action required',
      expected: 'Codex - action required'
    }
  ] as const)(
    'applies $mode $states against the tab title slot',
    async ({ mode, states, title, expected }) => {
      vi.resetModules()
      const store = createTestStore()
      const seeded = storeWithDivergedTitleSlots({ tabTitle: title, paneSlotTitle: 'Codex ready' })
      const otherLeaf = '22222222-2222-4222-8222-222222222222'
      if (mode === 'inactive-pane') {
        seeded.terminalLayoutsByTabId[TAB_ID] = {
          root: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', leafId: LEAF_ID },
            second: { type: 'leaf', leafId: otherLeaf }
          },
          activeLeafId: otherLeaf,
          expandedLeafId: null,
          titlesByLeafId: { [LEAF_ID]: 'Codex ready', [otherLeaf]: title }
        }
      }
      store.setState({ ...seeded, workspaceSessionReady: true, activeWorktreeId: null })
      const events = states.map((state, index): AgentStatusIpcPayload & AgentStatusSetData => ({
        paneKey: PANE_KEY,
        worktreeId: WORKTREE_ID,
        connectionId: null,
        state,
        agentType: 'codex',
        prompt: 'Title clearing test',
        receivedAt: Date.now() + index,
        stateStartedAt: Date.now() + index
      }))
      let onSet: (payload: AgentStatusSetData) => void = () => {
        throw new Error('listener missing')
      }
      vi.doMock('../../store', () => ({ useAppStore: store }))
      vi.stubGlobal(
        'window',
        buildWindowApi({
          getSnapshot: async () => (mode === 'snapshot' ? events : []),
          onSet: (callback) => {
            onSet = callback
            return () => {}
          }
        })
      )
      const { registerAgentStatusIpcBridge } = await import('./agent-status-ipc-bridge')
      const updateTitle = vi.spyOn(store.getState(), 'updateTabTitle')
      const updateTitles = vi.spyOn(store.getState(), 'updateTabTitles')
      const unsubs: (() => void)[] = []
      const bridge = registerAgentStatusIpcBridge(unsubs)
      try {
        if (mode !== 'snapshot') {
          onSet(events[0])
        }
        await vi.waitFor(() => {
          expect(store.getState().agentStatusByPaneKey[PANE_KEY]?.state).toBe(states.at(-1))
        })
        expect(store.getState().tabsByWorktree[WORKTREE_ID][0].title).toBe(expected)
        expect(store.getState().agentStatusByPaneKey[PANE_KEY].terminalTitle).toBe(
          states.at(-1) === 'done' ? 'Codex ready' : 'Codex - action required'
        )
        expect(updateTitle).toHaveBeenCalledTimes(mode === 'live' ? 1 : 0)
        expect(updateTitles).toHaveBeenCalledTimes(mode === 'snapshot' ? 1 : 0)
      } finally {
        bridge.disposeAsyncState()
        bridge.unsubscribeStore()
        unsubs.forEach((unsubscribe) => unsubscribe())
      }
    }
  )
})
