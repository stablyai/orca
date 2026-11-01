import { vi } from 'vitest'
import type { SetTerminalPaneTitleDetail, SplitTerminalPaneDetail } from '@/constants/terminal'
import type { TerminalLeafIntoTabResult } from '../../../../shared/terminal-leaf-move'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  makeTab,
  makeWorktree,
  seedStore,
  type createTestStore
} from '@/store/slices/store-test-helpers'
import type { TerminalTabIntoPaneDeps } from './terminal-tab-into-pane-types'
import {
  A,
  B,
  C,
  P_A,
  P_B,
  P_C,
  SOURCE,
  sourceLayout,
  TARGET,
  targetLayout,
  WT
} from './terminal-tab-into-pane-fixture'

type Store = ReturnType<typeof createTestStore>

/** Seeds the caller's real store with S (one leaf, pty-a) and T (leaves B, C), plus recording fakes for the rest. */
export function createJoinHarness(store: Store, overrides: Partial<TerminalTabIntoPaneDeps> = {}) {
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/worktree' })] },
    tabsByWorktree: {
      [WT]: [
        makeTab({ id: SOURCE, worktreeId: WT, ptyId: P_A, customTitle: null }),
        makeTab({ id: TARGET, worktreeId: WT, ptyId: P_B })
      ]
    },
    ptyIdsByTabId: { [SOURCE]: [P_A], [TARGET]: [P_B, P_C] },
    terminalLayoutsByTabId: { [SOURCE]: sourceLayout(), [TARGET]: targetLayout() }
  })
  const calls: string[] = []
  const splits: SplitTerminalPaneDetail[] = []
  // Whether the target was still expanded when each split was dispatched.
  const expandedAtSplit: boolean[] = []
  const requests: unknown[] = []
  const titleEvents: SetTerminalPaneTitleDetail[] = []
  let answer: () => Promise<TerminalLeafIntoTabResult> = () =>
    Promise.resolve({ status: 'moved', ptyId: P_A, sourceTabClosed: true })
  const mounted = [B, C]
  const remount = vi.fn(() => ({ remounted: true as const, generation: 1 }))
  const traced =
    <Args extends unknown[]>(name: string, fn: (...args: Args) => void) =>
    (...args: Args): void => {
      calls.push(`${name}:${String(args[0])}`)
      fn(...args)
    }
  const deps: TerminalTabIntoPaneDeps = {
    getStore: () => {
      const s = store.getState()
      return {
        ...s,
        setTabLayout: traced('setTabLayout', s.setTabLayout),
        syncPaneMoveIntoTabPtyOwnership: (args) => {
          calls.push('sync')
          s.syncPaneMoveIntoTabPtyOwnership(args)
        },
        closeTab: traced('closeTab', s.closeTab),
        setActiveTab: traced('setActiveTab', s.setActiveTab),
        remountTerminalTabForRecovery: (tabId) => {
          calls.push(`remount:${tabId}`)
          return remount()
        }
      }
    },
    mountedLeafIds: () => [...mounted],
    // A working handler mounts the new pane right away.
    dispatchSplit: (detail) => {
      calls.push('split')
      splits.push(detail)
      expandedAtSplit.push(Boolean(store.getState().expandedPaneByTabId[detail.tabId]))
      mounted.push(detail.newLeafId ?? '')
    },
    // The mounted pane collapses itself, which clears the tab's expanded flag.
    dispatchToggleExpand: (tabId) => {
      calls.push(`toggleExpand:${tabId}`)
      store.setState((s) => ({ expandedPaneByTabId: { ...s.expandedPaneByTabId, [tabId]: false } }))
    },
    dispatchPaneTitle: (detail) => {
      calls.push('title')
      titleEvents.push(detail)
    },
    scheduleGraphSync: () => calls.push('graphSync'),
    resyncParkedWatchers: (_worktreeId, tabId) => calls.push(`parked:${tabId}`),
    readMainSession: () => Promise.resolve(null),
    moveLeafIntoTab: (request) => {
      requests.push(request)
      return answer()
    },
    ...overrides
  }
  return {
    store,
    deps,
    calls,
    splits,
    expandedAtSplit,
    titleEvents,
    requests,
    remount,
    answerWith: (next: () => Promise<TerminalLeafIntoTabResult>) => {
      answer = next
    }
  }
}

/** Main's session after a committed join: T holds A, S is gone. */
export function mainSessionAfterJoin(): {
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
} {
  return {
    terminalLayoutsByTabId: {
      [TARGET]: {
        root: {
          type: 'split',
          direction: 'vertical',
          first: { type: 'leaf', leafId: B },
          second: { type: 'leaf', leafId: A }
        },
        activeLeafId: A,
        expandedLeafId: null
      }
    }
  }
}

export { C }
