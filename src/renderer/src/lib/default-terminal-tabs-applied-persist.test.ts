import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { useAppStore, type AppState } from '@/store'
import { applyDefaultTerminalTabs } from './worktree-default-terminal-tabs'
import { preserveRuntimeAuthoredWorkspaceSessionFields } from '../../../main/persistence/runtime-authored-workspace-session-fields'
import {
  createSessionWriteSubscriber,
  type WorkspaceSessionWrite
} from './session-write-subscriber'
import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'

let initialState: AppState

const WORKTREE_ID = 'repo1::/wt-1'
const DEFAULT_TABS = {
  runCommands: false,
  tabs: [{ title: 'Claude' }]
}

describe('defaultTerminalTabsAppliedByWorktreeId persist round-trip', () => {
  beforeEach(() => {
    initialState = useAppStore.getState()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    useAppStore.setState(initialState, true)
  })

  it('keeps the marker through mark, persist patch, omitted snapshot, and hydration', () => {
    const persist = vi.fn<(payload: WorkspaceSessionWrite) => void>()
    const cleanup = createSessionWriteSubscriber({ store: useAppStore, persist })

    useAppStore.setState({ workspaceSessionReady: true, hydrationSucceeded: true })
    vi.advanceTimersByTime(200)
    persist.mockClear()

    useAppStore.getState().markDefaultTerminalTabsApplied(WORKTREE_ID)
    vi.advanceTimersByTime(200)

    expect(persist.mock.calls[0][0].patch.defaultTerminalTabsAppliedByWorktreeId).toEqual({
      [WORKTREE_ID]: true
    })

    const patched = {
      ...getDefaultWorkspaceSession(),
      ...persist.mock.calls[0][0].patch
    }
    // Persist snapshots omit this write-once slice (empty payload / renderer never mentioned it).
    const omittedSnapshot = getDefaultWorkspaceSession()
    const preserved = preserveRuntimeAuthoredWorkspaceSessionFields(omittedSnapshot, patched)
    const parsed = parseWorkspaceSession(JSON.parse(JSON.stringify(preserved)))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      return
    }

    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
      }
    })
    store.getState().hydrateWorkspaceSession(parsed.value)

    expect(store.getState().defaultTerminalTabsAppliedByWorktreeId[WORKTREE_ID]).toBe(true)
    expect(
      applyDefaultTerminalTabs(
        store.getState(),
        WORKTREE_ID,
        undefined,
        undefined,
        undefined,
        DEFAULT_TABS,
        undefined,
        undefined
      )
    ).toBeNull()
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    cleanup()
  })

  it('does not drop in-memory markers when hydration omits the map', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/wt-1' })]
      }
    })
    store.getState().markDefaultTerminalTabsApplied(WORKTREE_ID)

    store.getState().hydrateWorkspaceSession({
      activeRepoId: 'repo1',
      activeWorktreeId: WORKTREE_ID,
      activeTabId: null,
      terminalLayoutsByTabId: {},
      tabsByWorktree: {}
    })

    expect(store.getState().defaultTerminalTabsAppliedByWorktreeId[WORKTREE_ID]).toBe(true)
    expect(
      applyDefaultTerminalTabs(
        store.getState(),
        WORKTREE_ID,
        undefined,
        undefined,
        undefined,
        DEFAULT_TABS,
        undefined,
        undefined
      )
    ).toBeNull()
  })
})
