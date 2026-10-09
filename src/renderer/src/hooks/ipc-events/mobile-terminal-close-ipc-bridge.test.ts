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
import { handleSwitchRecentTab } from '../ipc-tab-switch'

type OpenFilePayload = {
  worktreeId: string
  filePath: string
  relativePath: string
  runtimeEnvironmentId?: string
  navigation?: RuntimeNavigationTarget
  position?: { line: number; column?: number }
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

  it('CLI caller open adds the tab to the viewed worktree without leaving the focused terminal', () => {
    const { openFile, store } = setup('terminal')
    const before = screenState(store)
    expect(store.getState().activeTabType).toBe('terminal')

    openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    expect(tabEntityIds(store, VIEWED)).toContain(VIEWED_APP_TS.filePath)
  })

  it('CLI caller diff is added to the viewed worktree without replacing the visible editor', () => {
    const { openDiff, store } = setup('editor')
    const before = screenState(store)
    expect(store.getState().activeFileId).toBe(VIEWED_FILE)

    openDiff({ worktreeId: VIEWED, ...VIEWED_APP_TS, staged: false, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    expect(
      store.getState().openFiles.some((file) => file.mode === 'diff' && file.worktreeId === VIEWED)
    ).toBe(true)
  })

  it('CLI caller open in a background worktree leaves the viewed editor alone', () => {
    const { openFile, store } = setup('editor')
    const before = screenState(store)

    openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    // Why: the tab is that worktree's selection, so it is what the user sees on going there.
    expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
    expect(store.getState().activeFileIdByWorktree[BACKGROUND]).toBe(APP_TS.filePath)
    store.getState().setActiveWorktree(BACKGROUND)
    expect(store.getState().activeFileId).toBe(APP_TS.filePath)
    expect(store.getState().activeTabType).toBe('editor')
  })

  it('CLI caller diff in a background worktree leaves the viewed editor alone', () => {
    const { openDiff, store } = setup('editor')
    const before = screenState(store)

    openDiff({ worktreeId: BACKGROUND, ...APP_TS, staged: true, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    const opened = store
      .getState()
      .openFiles.find((file) => file.mode === 'diff' && file.worktreeId === BACKGROUND)
    expect(opened?.diffSource).toBe('staged')
    expect(activeEditorEntityId(store, BACKGROUND)).toBe(opened?.id)
  })

  it('CLI caller reopen of an already-open file keeps the focused terminal', () => {
    const { openFile, store } = setup('terminal')
    const before = screenState(store)
    const tabCount = tabEntityIds(store, VIEWED).length

    openFile({
      worktreeId: VIEWED,
      filePath: VIEWED_FILE,
      relativePath: 'notes.md',
      navigation: 'caller'
    })
    openFile({
      worktreeId: VIEWED,
      filePath: VIEWED_FILE,
      relativePath: 'notes.md',
      navigation: 'caller'
    })

    expect(screenState(store)).toEqual(before)
    expect(tabEntityIds(store, VIEWED)).toHaveLength(tabCount)
  })

  it('CLI caller reopen of an already-open diff keeps the focused terminal', () => {
    const { openDiff, store } = setup('terminal')
    const before = screenState(store)

    openDiff({ worktreeId: VIEWED, ...VIEWED_APP_TS, staged: false, navigation: 'caller' })
    const tabCount = tabEntityIds(store, VIEWED).length
    openDiff({ worktreeId: VIEWED, ...VIEWED_APP_TS, staged: false, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    expect(tabEntityIds(store, VIEWED)).toHaveLength(tabCount)
  })

  it('selects a background CLI tab without stamping a visit, keeping its tab history', () => {
    const { openFile, store } = setup('editor')
    const terminal = store.getState().createTab(BACKGROUND)
    const tabId = (entityId: string): string | undefined =>
      store.getState().unifiedTabsByWorktree[BACKGROUND]?.find((tab) => tab.entityId === entityId)
        ?.id
    const focusTimes = (): [string, number | undefined][] =>
      (store.getState().unifiedTabsByWorktree[BACKGROUND] ?? []).map((tab) => [
        tab.entityId,
        tab.lastFocusedAt
      ])
    const history = (): string[] | undefined =>
      store.getState().groupsByWorktree[BACKGROUND]?.[0]?.recentTabIds
    const timesBefore = focusTimes()

    openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation: 'caller' })

    expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
    // Why: the jump palette's recent rows sort by lastFocusedAt; the user never looked at this tab.
    expect(focusTimes()).toEqual([...timesBefore, [APP_TS.filePath, undefined]])
    // Why: the group history must still end on the active tab, or Ctrl+Tab has nowhere to go back to.
    expect(history()?.at(-1)).toBe(tabId(APP_TS.filePath))

    store.getState().activateTab(tabId(terminal.id) ?? '')
    const timesBeforeReopen = focusTimes()
    openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation: 'caller' })

    expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
    expect(focusTimes()).toEqual(timesBeforeReopen)
    expect(history()?.at(-1)).toBe(tabId(APP_TS.filePath))
  })

  it.each([
    ['a new tab', false],
    ['a reopened tab already in the history', true]
  ] as const)('Ctrl+Tab works after a background CLI open of %s', (_label, reopen) => {
    const { openFile, store } = setup('editor')
    store.getState().setActiveWorktree(BACKGROUND)
    const terminal = store.getState().createTab(BACKGROUND)
    store.getState().setActiveTabType('terminal', BACKGROUND)
    store.getState().setActiveWorktree(VIEWED)
    const terminalTabId = store
      .getState()
      .unifiedTabsByWorktree[BACKGROUND]?.find((tab) => tab.entityId === terminal.id)?.id
    if (reopen) {
      openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation: 'caller' })
      // Why: the user went back to the terminal, so the file is in the history but not last.
      store.getState().activateTab(terminalTabId ?? '')
    }

    openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation: 'caller' })
    store.getState().setActiveWorktree(BACKGROUND)
    store.getState().setActiveTabType('editor', BACKGROUND)

    expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
    expect(handleSwitchRecentTab()).toBe(true)
    expect(activeEditorEntityId(store, BACKGROUND)).toBe(terminal.id)
  })

  it('switches the desktop for a phone open (no navigation field), as before', () => {
    const { openFile, store } = setup('terminal')

    openFile({ worktreeId: BACKGROUND, ...APP_TS })

    const state = store.getState()
    expect(state.activeWorktreeId).toBe(BACKGROUND)
    expect(state.activeView).toBe('terminal')
    expect(state.activeFileId).toBe(APP_TS.filePath)
    expect(state.activeTabType).toBe('editor')
    expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
    expect(state.pendingRevealWorktree?.worktreeId).toBe(BACKGROUND)
    expect(state.lastVisitedAtByWorktreeId[BACKGROUND]).toBeDefined()
  })

  it('selects a phone-opened diff in the viewed worktree so "Open in session" lands on it', () => {
    const { openDiff, store } = setup('terminal')

    openDiff({ worktreeId: VIEWED, ...VIEWED_APP_TS, staged: false })

    const state = store.getState()
    const diff = state.openFiles.find((file) => file.mode === 'diff' && file.worktreeId === VIEWED)
    expect(state.activeWorktreeId).toBe(VIEWED)
    expect(state.activeTabType).toBe('editor')
    expect(state.activeFileId).toBe(diff?.id)
    expect(activeEditorEntityId(store, VIEWED)).toBe(diff?.id)
    const snapshot = buildMobileSessionTabSnapshots(state, false).find(
      (candidate) => candidate.worktree === VIEWED
    )
    const activeTab = snapshot?.tabs.find((tab) => tab.id === snapshot.activeTabId)
    expect(activeTab && 'relativePath' in activeTab ? activeTab.relativePath : null).toBe(
      VIEWED_APP_TS.relativePath
    )
  })

  it('publishes a CLI caller tab to the phone tab list without moving the desktop', () => {
    const { openFile, store } = setup('terminal')
    const before = screenState(store)

    openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    const snapshot = buildMobileSessionTabSnapshots(store.getState(), false).find(
      (candidate) => candidate.worktree === VIEWED
    )
    expect(
      snapshot?.tabs.some(
        (tab) => 'relativePath' in tab && tab.relativePath === VIEWED_APP_TS.relativePath
      )
    ).toBe(true)
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

describe('runtime file opens at a cursor position', () => {
  const frames: FrameRequestCallback[] = []

  function flushFrames(): void {
    while (frames.length > 0) {
      frames.shift()?.(0)
    }
  }

  beforeEach(() => {
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
  })

  it('puts the cursor where the caller asked once the editor can take it', () => {
    const { openFile, store } = setup('editor')

    openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'all',
      position: { line: 12, column: 5 }
    })
    // Why: the reveal waits for Monaco to remount on the new tab, as Quick Open's does.
    expect(store.getState().pendingEditorReveal).toBeNull()
    flushFrames()

    expect(store.getState().pendingEditorReveal).toEqual({
      filePath: VIEWED_APP_TS.filePath,
      fileId: VIEWED_APP_TS.filePath,
      line: 12,
      column: 5,
      matchLength: 0
    })
  })

  it('starts a line without a column at its first character', () => {
    const { openFile, store } = setup('editor')

    openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'all', position: { line: 3 } })
    flushFrames()

    expect(store.getState().pendingEditorReveal).toMatchObject({ line: 3, column: 1 })
  })

  it('opens a markdown file in source view, where its lines exist', () => {
    const { openFile, store } = setup('terminal')

    openFile({
      worktreeId: BACKGROUND,
      filePath: '/repo1/background/docs/guide.md',
      relativePath: 'docs/guide.md',
      navigation: 'all',
      position: { line: 8 }
    })
    flushFrames()

    const state = store.getState()
    expect(state.markdownViewMode['/repo1/background/docs/guide.md']).toBe('source')
    expect(state.pendingEditorReveal).toMatchObject({
      filePath: '/repo1/background/docs/guide.md',
      line: 8
    })
  })

  it('keeps the cursor where it was when the caller sent no position', () => {
    const { openFile, store } = setup('editor')

    openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'all' })
    flushFrames()

    expect(store.getState().pendingEditorReveal).toBeNull()
    expect(store.getState().markdownViewMode[VIEWED_APP_TS.filePath]).toBeUndefined()
  })
})
