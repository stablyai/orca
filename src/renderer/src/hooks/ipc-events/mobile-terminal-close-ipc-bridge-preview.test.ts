import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeNavigationTarget } from '../../../../shared/runtime-navigation'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import type * as HostPersistence from '@/lib/workspace-session-host-persistence'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../store/slices/tabs-drawn-from-main.test-fixture'

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
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      testStore().subscribe(...args),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args)
  }
}))
vi.mock('@/components/terminal-pane/closed-terminal-leaf-notice', () => ({
  applyClosedTerminalLeafNotice: vi.fn()
}))
vi.mock('@/components/terminal/terminal-tab-actions', () => ({ closeTerminalTab: vi.fn() }))
vi.mock('@/components/sidebar/sleep-worktree-flow', () => ({ runSleepWorktree: vi.fn() }))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
vi.mock('@/lib/workspace-session-host-persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof HostPersistence>()),
  persistWorkspaceSessionByHost: vi.fn()
}))

import { registerMobileAndTerminalCloseIpcBridge } from './mobile-terminal-close-ipc-bridge'

type OpenFilePayload = {
  worktreeId: string
  filePath: string
  relativePath: string
  navigation?: RuntimeNavigationTarget
  preview?: boolean
}
type TestStore = ReturnType<typeof createTestStore>

const VIEWED = 'repo1::/repo1/viewed'
const PAGE = { filePath: '/repo1/viewed/site/index.html', relativePath: 'site/index.html' }
const README = { filePath: '/repo1/viewed/README.md', relativePath: 'README.md' }

let main: TabsDrawnFromMain | null = null

afterEach(() => {
  main?.close()
  main = null
})

async function setup(): Promise<{
  openFile: (payload: OpenFilePayload) => Promise<void>
  store: TestStore
}> {
  let listener: ((payload: OpenFilePayload) => void) | undefined
  const noop = (): (() => void) => () => {}
  vi.stubGlobal('window', {
    api: {
      ...createStoreSessionMockApi(),
      ui: {
        onOpenFileFromMobile: (cb: (payload: OpenFilePayload) => void) => {
          listener = cb
          return () => {}
        },
        onOpenDiffFromMobile: noop,
        onCloseTerminal: noop,
        onWorkspaceSleep: noop,
        onResumeSleepingAgents: noop
      }
    }
  })
  const store = createTestStore()
  storeRef.current = store
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: VIEWED, repoId: 'repo1', path: '/repo1/viewed' })]
    }
  })
  store.getState().setActiveWorktree(VIEWED)
  main = await drawTabsFromMain(store)
  store.getState().openFile({
    filePath: '/repo1/viewed/notes.md',
    relativePath: 'notes.md',
    worktreeId: VIEWED,
    language: 'markdown',
    runtimeEnvironmentId: null,
    mode: 'edit'
  })
  await main.settle()
  registerMobileAndTerminalCloseIpcBridge([], vi.fn())
  if (!listener) {
    throw new Error('file-open listener was not registered')
  }
  const open = listener
  return {
    openFile: async (payload) => {
      open(payload)
      await main?.settle()
    },
    store
  }
}

function browserTabs(store: TestStore, worktreeId: string): unknown[] {
  return store.getState().browserTabsByWorktree[worktreeId] ?? []
}

function hasSource(store: TestStore, filePath: string): boolean {
  return store.getState().openFiles.some((file) => file.filePath === filePath)
}

function hasEditTab(store: TestStore, filePath: string): boolean {
  return store.getState().openFiles.some((f) => f.filePath === filePath && f.mode === 'edit')
}

function screenState(store: TestStore): Record<string, unknown> {
  const s = store.getState()
  return {
    activeWorktreeId: s.activeWorktreeId,
    activeView: s.activeView,
    activeTabType: s.activeTabType,
    activeFileId: s.activeFileId,
    activeTabId: s.activeTabId,
    activeGroupId: s.activeGroupIdByWorktree[VIEWED],
    activeTabByGroup: Object.fromEntries(
      (s.groupsByWorktree[VIEWED] ?? []).map((group) => [group.id, group.activeTabId])
    )
  }
}

describe('runtime file opens with preview', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens HTML in a browser tab instead of its source', async () => {
    const { openFile, store } = await setup()

    await openFile({ worktreeId: VIEWED, ...PAGE, navigation: 'all', preview: true })

    expect(browserTabs(store, VIEWED)).toHaveLength(1)
    expect(hasSource(store, PAGE.filePath)).toBe(false)
  })

  it.each([
    ['HTML', PAGE],
    ['Markdown', README]
  ])('adds a caller %s preview without changing what the user sees', async (_kind, file) => {
    const { openFile, store } = await setup()
    const before = screenState(store)

    await openFile({ worktreeId: VIEWED, ...file, navigation: 'caller', preview: true })

    expect(store.getState().unifiedTabsByWorktree[VIEWED]).toHaveLength(2)
    // Why: toMatchObject lets a layout add a pane for the preview, as long as focus and existing panes stay put.
    expect(screenState(store)).toMatchObject(before)
  })

  it('opens Markdown in its read-only preview tab', async () => {
    const { openFile, store } = await setup()

    await openFile({ worktreeId: VIEWED, ...README, navigation: 'all', preview: true })

    const active = store.getState().openFiles.find((f) => f.id === store.getState().activeFileId)
    expect(active).toMatchObject({ filePath: README.filePath, mode: 'markdown-preview' })
    expect(hasEditTab(store, README.filePath)).toBe(false)
  })

  it('falls back to HTML source when the workspace cannot show a preview', async () => {
    const { openFile, store } = await setup()
    // No known owner means no channel to preview through.
    const unowned = 'repo2::/repo2/unowned'
    const page = { filePath: '/repo2/unowned/index.html', relativePath: 'index.html' }

    await openFile({ worktreeId: unowned, ...page, navigation: 'caller', preview: true })

    expect(browserTabs(store, unowned)).toHaveLength(0)
    expect(hasSource(store, page.filePath)).toBe(true)
  })

  it('opens source without the preview flag', async () => {
    const { openFile, store } = await setup()

    await openFile({ worktreeId: VIEWED, ...PAGE, navigation: 'all' })
    await openFile({ worktreeId: VIEWED, ...README, navigation: 'all' })

    expect(browserTabs(store, VIEWED)).toHaveLength(0)
    expect(hasSource(store, PAGE.filePath)).toBe(true)
    expect(hasEditTab(store, README.filePath)).toBe(true)
  })
})
