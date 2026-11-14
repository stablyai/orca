import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, seedStore } from '../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import { createStoreSessionMockApi } from '../../store/testing/app-store-session-api.test-fixture'
import type * as HostPersistence from '@/lib/workspace/persistence/workspace-session-host-persistence'

import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../store/slices/tabs/tabs-drawn-from-main.test-fixture'

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
vi.mock('../../store/index', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      testStore().subscribe(...args),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args)
  }
}))
vi.mock('@/components/terminal-pane/layout/close/closed-terminal-leaf-notice', () => ({
  applyClosedTerminalLeafNotice: vi.fn()
}))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))
vi.mock('@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow', () => ({
  runSleepWorktree: vi.fn()
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock(
  '@/lib/workspace/persistence/workspace-session-host-persistence',
  async (importOriginal) => ({
    ...(await importOriginal<typeof HostPersistence>()),
    persistWorkspaceSessionByHost: vi.fn()
  })
)

import { registerMobileAndTerminalCloseIpcBridge } from './mobile-terminal-close-ipc-bridge'

type OpenFilePayload = {
  worktreeId: string
  filePath: string
  relativePath: string
  runtimeEnvironmentId?: string | null
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

let main: TabsDrawnFromMain | null = null

afterEach(() => {
  main?.close()
  main = null
})

async function settle(): Promise<void> {
  await main?.settle()
}

async function setup(viewedSurface: 'editor' | 'terminal'): Promise<{
  openFile: (payload: OpenFilePayload) => Promise<void>
  openDiff: (payload: OpenDiffPayload) => Promise<void>
  store: TestStore
  dispose: () => void
}> {
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
        onWorkspaceSleep: () => () => {},
        onResumeSleepingAgents: () => () => {}
      }
    }
  })
  const store = createTestStore()
  storeRef.current = store
  seedStore(store, {
    sidebarBody: 'workspaces',
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: VIEWED, repoId: 'repo1', path: '/repo1/viewed' }),
        makeWorktree({ id: BACKGROUND, repoId: 'repo1', path: '/repo1/background' })
      ]
    }
  })
  store.getState().setActiveWorktree(VIEWED)
  main = await drawTabsFromMain(store)
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
  await settle()
  store.setState({ activeView: 'terminal', pendingRevealWorktree: null })
  const unsubs: (() => void)[] = []
  registerMobileAndTerminalCloseIpcBridge(unsubs, vi.fn())
  const { openFile, openDiff } = listeners
  if (!openFile || !openDiff) {
    throw new Error('file-open listeners were not registered')
  }
  return {
    openFile: async (payload) => {
      openFile(payload)
      await settle()
    },
    openDiff: async (payload) => {
      openDiff(payload)
      await settle()
    },
    store,
    dispose: () => unsubs.forEach((unsubscribe) => unsubscribe())
  }
}

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

  it('CLI caller open adds the tab to the viewed worktree without leaving the focused terminal', async () => {
    const { openFile, store } = await setup('terminal')
    const before = screenState(store)
    expect(store.getState().activeTabType).toBe('terminal')

    await openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    expect(tabEntityIds(store, VIEWED)).toContain(VIEWED_APP_TS.filePath)
  })

  it('CLI caller open in a background worktree leaves the viewed editor alone', async () => {
    const { openFile, store } = await setup('editor')
    const before = screenState(store)

    await openFile({ worktreeId: BACKGROUND, ...APP_TS, navigation: 'caller' })

    expect(screenState(store)).toEqual(before)
    expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
    expect(store.getState().activeFileIdByWorktree[BACKGROUND]).toBe(APP_TS.filePath)
    store.getState().setActiveWorktree(BACKGROUND)
    expect(store.getState().activeFileId).toBe(APP_TS.filePath)
    expect(store.getState().activeTabType).toBe('editor')
  })

  it.each(['workspaces', 'conversations'] as const)(
    'opens a phone-selected file while preserving the %s sidebar',
    async (sidebarBody) => {
      const { openFile, store } = await setup('terminal')
      store.setState({ sidebarBody })

      await openFile({ worktreeId: BACKGROUND, ...APP_TS })

      const state = store.getState()
      expect(state.activeWorktreeId).toBe(BACKGROUND)
      expect(state.activeView).toBe('terminal')
      expect(state.activeFileId).toBe(APP_TS.filePath)
      expect(state.activeTabType).toBe('editor')
      expect(activeEditorEntityId(store, BACKGROUND)).toBe(APP_TS.filePath)
      expect(state.sidebarBody).toBe(sidebarBody)
      expect(state.pendingRevealWorktree?.worktreeId).toBe(
        sidebarBody === 'workspaces' ? BACKGROUND : undefined
      )
      expect(state.lastVisitedAtByWorktreeId[BACKGROUND]).toBeDefined()
    }
  )

  describe('with another server focused', () => {
    const FRESH = 'repo9::/repo9/fresh'
    const FRESH_TS = { filePath: '/repo1/fresh/src/app.ts', relativePath: 'src/app.ts' }

    function focusServer(store: TestStore): void {
      store.setState({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: owner routing reads only these fields.
        settings: { activeRuntimeEnvironmentId: 'srv-focused' } as never,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: owner routing reads only the saved id.
        runtimeEnvironments: [{ id: 'srv-focused' } as never]
      })
    }

    it('keeps a desktop-owned file open on this desktop', async () => {
      const { openFile, store } = await setup('editor')
      focusServer(store)

      await openFile({
        worktreeId: FRESH,
        ...FRESH_TS,
        runtimeEnvironmentId: null,
        navigation: 'caller'
      })

      const opened = store.getState().openFiles.find((file) => file.worktreeId === FRESH)
      expect(opened?.runtimeEnvironmentId).toBeNull()
    })
  })
})

describe('runtime file positioning', () => {
  const frames: FrameRequestCallback[] = []
  beforeEach(() => {
    frames.length = 0
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      frames.push(callback)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  function flushFrames(): void {
    while (frames.length) {
      frames.shift()?.(0)
    }
  }

  it.each([undefined, { line: 17 }])(
    'preserves a visible floating editor when another file opens in the background (position %s)',
    async (position) => {
      const { openFile, store } = await setup('editor')
      store.setState({
        settings: { ...getDefaultSettings('/tmp'), floatingTerminalEnabled: true },
        floatingWorkspacePanelOpen: true,
        floatingWorkspacePath: '/tmp/floating'
      })
      await openFile({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        filePath: '/tmp/floating/first.ts',
        relativePath: 'first.ts',
        navigation: 'all'
      })
      const before = activeEditorEntityId(store, FLOATING_TERMINAL_WORKTREE_ID)
      await openFile({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        filePath: '/tmp/floating/second.ts',
        relativePath: 'second.ts',
        navigation: 'caller',
        position
      })
      flushFrames()
      expect(activeEditorEntityId(store, FLOATING_TERMINAL_WORKTREE_ID)).toBe(before)
      expect(store.getState().pendingEditorReveal).toBeNull()
    }
  )

  it('preserves a viewed terminal until the positioned background file is selected', async () => {
    const { openFile, store } = await setup('terminal')
    const before = screenState(store)
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'caller',
      position: { line: 3 }
    })
    flushFrames()
    expect(screenState(store)).toEqual(before)
    expect(store.getState().pendingEditorReveal).toBeNull()
    const tab = store
      .getState()
      .unifiedTabsByWorktree[VIEWED]?.find(
        (candidate) => candidate.entityId === VIEWED_APP_TS.filePath
      )
    store.getState().activateTab(tab?.id ?? '')
    flushFrames()
    expect(store.getState().pendingEditorReveal).toMatchObject({
      fileId: VIEWED_APP_TS.filePath,
      line: 3,
      column: 1
    })
  })

  it('invalidates a published reveal if navigation changes before Monaco applies it', async () => {
    const { openFile, store } = await setup('terminal')
    const terminal = store.getState().getActiveTab(VIEWED)
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'all',
      position: { line: 17 }
    })
    flushFrames()
    const reveal = store.getState().pendingEditorReveal
    expect(reveal?.canApply?.()).toBe(true)
    store.getState().activateTab(terminal?.id ?? '')
    expect(reveal?.canApply?.()).toBe(false)
  })

  it('invalidates an already-published reveal when its bridge is disposed', async () => {
    const { openFile, store, dispose } = await setup('terminal')
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'all',
      position: { line: 17 }
    })
    flushFrames()
    const reveal = store.getState().pendingEditorReveal
    expect(reveal?.canApply?.()).toBe(true)
    dispose()
    expect(reveal?.canApply?.()).toBe(false)
  })

  it('does not publish an old position after a close and reopen during queued frames', async () => {
    const { openFile, store } = await setup('terminal')
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'all',
      position: { line: 17 }
    })
    store.getState().closeFile(VIEWED_APP_TS.filePath)
    await settle()
    await openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'all' })
    flushFrames()
    expect(store.getState().pendingEditorReveal).toBeNull()
  })

  it('keeps the latest position for a repeated background open', async () => {
    const { openFile, store } = await setup('terminal')
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'caller',
      position: { line: 3 }
    })
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'caller',
      position: { line: 19 }
    })
    const tab = store
      .getState()
      .unifiedTabsByWorktree[VIEWED]?.find(
        (candidate) => candidate.entityId === VIEWED_APP_TS.filePath
      )
    store.getState().activateTab(tab?.id ?? '')
    flushFrames()
    expect(store.getState().pendingEditorReveal).toMatchObject({ line: 19 })
  })

  it('invalidates a published position when a plain open follows', async () => {
    const { openFile, store } = await setup('terminal')
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'all',
      position: { line: 17 }
    })
    flushFrames()
    const reveal = store.getState().pendingEditorReveal
    expect(reveal?.canApply?.()).toBe(true)
    await openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'caller' })
    expect(reveal?.canApply?.()).toBe(false)
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'all',
      position: { line: 23 }
    })
    flushFrames()
    expect(store.getState().pendingEditorReveal).toMatchObject({ line: 23 })
    expect(store.getState().pendingEditorReveal?.canApply?.()).toBe(true)
  })

  it('keeps another owner’s queued position when a same-path plain open follows', async () => {
    const { openFile, store } = await setup('terminal')
    await openFile({
      worktreeId: VIEWED,
      ...VIEWED_APP_TS,
      navigation: 'caller',
      position: { line: 3 }
    })
    await openFile({
      worktreeId: BACKGROUND,
      ...VIEWED_APP_TS,
      runtimeEnvironmentId: 'remote-1',
      navigation: 'caller',
      position: { line: 19 }
    })
    await openFile({ worktreeId: VIEWED, ...VIEWED_APP_TS, navigation: 'caller' })
    store.getState().setActiveWorktree(BACKGROUND)
    flushFrames()
    const remote = store
      .getState()
      .openFiles.find((file) => file.runtimeEnvironmentId === 'remote-1')
    expect(store.getState().pendingEditorReveal).toMatchObject({ fileId: remote?.id, line: 19 })
    store.getState().setPendingEditorReveal(null)
    store.getState().setActiveWorktree(VIEWED)
    const tab = store
      .getState()
      .unifiedTabsByWorktree[VIEWED]?.find(
        (candidate) => candidate.entityId === VIEWED_APP_TS.filePath
      )
    store.getState().activateTab(tab?.id ?? '')
    flushFrames()
    expect(store.getState().pendingEditorReveal).toBeNull()
  })
})
