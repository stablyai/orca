import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import { buildMobileSessionTabSnapshots } from '@/runtime/sync-runtime-graph/mobile-session-snapshots'

const { storeRef } = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return { storeRef: ref }
})

function testStore(): ReturnType<typeof createTestStore> {
  if (!storeRef.current) {
    throw new Error('test store not created')
  }
  return storeRef.current
}

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args)
  }
}))
vi.mock('@/components/terminal-pane/closed-terminal-leaf-notice', () => ({
  applyClosedTerminalLeafNotice: vi.fn()
}))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))
vi.mock('@/components/sidebar/sleep-worktree-flow', () => ({ runSleepWorktree: vi.fn() }))
vi.mock('@/lib/workspace-session', () => ({ buildWorkspaceSessionPayload: vi.fn() }))
vi.mock('@/lib/workspace-session-host-persistence', () => ({
  persistWorkspaceSessionByHost: vi.fn()
}))

import { registerMobileAndTerminalCloseIpcBridge } from './mobile-terminal-close-ipc-bridge'

type OpenFilePayload = {
  worktreeId: string
  filePath: string
  relativePath: string
  runtimeEnvironmentId?: string
  navigation?: RuntimeNavigationTarget
}
type OpenDiffPayload = OpenFilePayload & { staged: boolean }
type TestStore = ReturnType<typeof createTestStore>

const VIEWED = 'repo1::/repo1/viewed'
const BACKGROUND = 'repo1::/repo1/background'
const VIEWED_FILE = '/repo1/viewed/notes.md'
const APP_TS = { filePath: '/repo1/background/src/app.ts', relativePath: 'src/app.ts' }
const VIEWED_APP_TS = { filePath: '/repo1/viewed/src/app.ts', relativePath: 'src/app.ts' }

function setup(viewedSurface: 'editor' | 'terminal'): {
  openFile: (payload: OpenFilePayload) => void
  openDiff: (payload: OpenDiffPayload) => void
  store: TestStore
} {
  const mockApi = createStoreSessionMockApi()
  const listeners: {
    openFile?: (payload: OpenFilePayload) => void
    openDiff?: (payload: OpenDiffPayload) => void
  } = {}
  vi.stubGlobal('window', {
    api: {
      ...mockApi,
      ui: {
        onOpenFileFromMobile: (cb: (payload: OpenFilePayload) => void) => {
          listeners.openFile = cb
          return () => {}
        },
        onOpenDiffFromMobile: (cb: (payload: OpenDiffPayload) => void) => {
          listeners.openDiff = cb
          return () => {}
        },
        onCloseTerminal: () => () => {},
        onSleepWorktree: () => () => {},
        onResumeSleepingAgents: () => () => {}
      }
    }
  })
  const store = createTestStore()
  storeRef.current = store
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: VIEWED, repoId: 'repo1', path: '/repo1/viewed' }),
        makeWorktree({ id: BACKGROUND, repoId: 'repo1', path: '/repo1/background' })
      ]
    }
  })
  store.getState().setActiveWorktree(VIEWED)
  store.getState().openFile({
    filePath: VIEWED_FILE,
    relativePath: 'notes.md',
    worktreeId: VIEWED,
    language: 'markdown',
    runtimeEnvironmentId: null,
    mode: 'edit'
  })
  if (viewedSurface === 'terminal') {
    store.getState().createTab(VIEWED)
    store.getState().setActiveTabType('terminal', VIEWED)
  }
  store.setState({ activeView: 'terminal', pendingRevealWorktree: null })
  registerMobileAndTerminalCloseIpcBridge([], vi.fn())
  const { openFile, openDiff } = listeners
  if (!openFile || !openDiff) {
    throw new Error('file-open listeners were not registered')
  }
  return { openFile, openDiff, store }
}

/** Everything the user can see or type into on the desktop. */
function screenState(store: TestStore): unknown {
  const s = store.getState()
  return {
    activeWorktreeId: s.activeWorktreeId,
    activeView: s.activeView,
    activeTabType: s.activeTabType,
    activeFileId: s.activeFileId,
    activeTabId: s.activeTabId,
    viewedActiveFile: s.activeFileIdByWorktree[VIEWED],
    viewedActiveTabType: s.activeTabTypeByWorktree[VIEWED],
    viewedActiveGroup: s.activeGroupIdByWorktree[VIEWED],
    viewedGroups: s.groupsByWorktree[VIEWED]?.map((group) => ({
      id: group.id,
      activeTabId: group.activeTabId
    })),
    pendingEditorFocusRequest: s.pendingEditorFocusRequest,
    pendingRevealWorktree: s.pendingRevealWorktree,
    backgroundVisitedAt: s.lastVisitedAtByWorktreeId[BACKGROUND]
  }
}

function tabEntityIds(store: TestStore, worktreeId: string): string[] {
  return (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).map((tab) => tab.entityId)
}

function activeEditorEntityId(store: TestStore, worktreeId: string): string | undefined {
  const state = store.getState()
  const group = state.groupsByWorktree[worktreeId]?.find(
    (candidate) => candidate.id === state.activeGroupIdByWorktree[worktreeId]
  )
  return state.unifiedTabsByWorktree[worktreeId]?.find((tab) => tab.id === group?.activeTabId)
    ?.entityId
}

describe('runtime file opens on the host desktop', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('adds the tab to the viewed worktree without leaving the focused terminal', () => {
    const { openFile, store } = setup('terminal')
    const before = screenState(store)
    expect(store.getState().activeTabType).toBe('terminal')

    openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS })

    expect(screenState(store)).toEqual(before)
    expect(tabEntityIds(store, VIEWED)).toContain(VIEWED_APP_TS.filePath)
  })

  it('adds a diff to the viewed worktree without replacing the visible editor', () => {
    const { openDiff, store } = setup('editor')
    const before = screenState(store)
    expect(store.getState().activeFileId).toBe(VIEWED_FILE)

    openDiff({ worktreeId: VIEWED, ...VIEWED_APP_TS, staged: false })

    expect(screenState(store)).toEqual(before)
    expect(
      store.getState().openFiles.some((file) => file.mode === 'diff' && file.worktreeId === VIEWED)
    ).toBe(true)
  })

  it('opens in a background worktree without touching the viewed editor', () => {
    const { openFile, store } = setup('editor')
    const before = screenState(store)

    openFile({ worktreeId: BACKGROUND, ...APP_TS })

    expect(screenState(store)).toEqual(before)
    // Why: the tab is that worktree's selection, so it is what the user sees on going there.
    expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
    expect(store.getState().activeFileIdByWorktree[BACKGROUND]).toBe(APP_TS.filePath)
    store.getState().setActiveWorktree(BACKGROUND)
    expect(store.getState().activeFileId).toBe(APP_TS.filePath)
    expect(store.getState().activeTabType).toBe('editor')
  })

  it('opens a background diff without touching the viewed editor', () => {
    const { openDiff, store } = setup('editor')
    const before = screenState(store)

    openDiff({ worktreeId: BACKGROUND, ...APP_TS, staged: true })

    expect(screenState(store)).toEqual(before)
    const opened = store
      .getState()
      .openFiles.find((file) => file.mode === 'diff' && file.worktreeId === BACKGROUND)
    expect(opened?.diffSource).toBe('staged')
    expect(activeEditorEntityId(store, BACKGROUND)).toBe(opened?.id)
  })

  it('keeps the desktop still for a phone open (no navigation field) and still publishes the tab', () => {
    const { openFile, store } = setup('terminal')
    const before = screenState(store)

    openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS })
    openFile({ worktreeId: BACKGROUND, ...APP_TS })

    expect(screenState(store)).toEqual(before)
    const snapshots = buildMobileSessionTabSnapshots(store.getState(), false)
    for (const [worktreeId, relativePath] of [
      [VIEWED, VIEWED_APP_TS.relativePath],
      [BACKGROUND, APP_TS.relativePath]
    ]) {
      const snapshot = snapshots.find((candidate) => candidate.worktree === worktreeId)
      expect(
        snapshot?.tabs.some((tab) => 'relativePath' in tab && tab.relativePath === relativePath)
      ).toBe(true)
    }
  })

  it.each(['caller', 'clients'] as const)(
    'keeps the desktop still when navigation %s does not target the host',
    (navigation) => {
      const { openFile, store } = setup('terminal')
      const before = screenState(store)

      openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation })
      openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation })

      expect(screenState(store)).toEqual(before)
    }
  )

  it.each(['all', 'host'] as const)(
    'brings the user to the file with navigation %s',
    (navigation) => {
      const { openFile, store } = setup('terminal')

      openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation })

      const state = store.getState()
      expect(state.activeWorktreeId).toBe(BACKGROUND)
      expect(state.activeView).toBe('terminal')
      expect(state.activeFileId).toBe(APP_TS.filePath)
      expect(state.activeTabType).toBe('editor')
      expect(state.pendingRevealWorktree?.worktreeId).toBe(BACKGROUND)
      expect(state.lastVisitedAtByWorktreeId[BACKGROUND]).toBeDefined()
    }
  )

  it('selects the tab over a focused terminal in the viewed worktree with navigation all', () => {
    const { openFile, store } = setup('terminal')

    openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'all' })

    expect(store.getState().activeTabType).toBe('editor')
    expect(store.getState().activeFileId).toBe(VIEWED_APP_TS.filePath)
    expect(activeEditorEntityId(store, VIEWED)).toBe(VIEWED_APP_TS.filePath)
  })

  it('brings the user to a diff with navigation all', () => {
    const { openDiff, store } = setup('editor')

    openDiff({ worktreeId: BACKGROUND, ...APP_TS, staged: false, navigation: 'all' })

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(BACKGROUND)
    expect(state.openFiles.find((file) => file.id === state.activeFileId)?.mode).toBe('diff')
    expect(state.pendingRevealWorktree?.worktreeId).toBe(BACKGROUND)
  })
})
