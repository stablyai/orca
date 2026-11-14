// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, seedStore } from '../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../store/slices/worktrees/worktree.test-fixture'
import { createStoreSessionMockApi } from '../../store/testing/app-store-session-api.test-fixture'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '../../store/slices/tabs/tabs-drawn-from-main.test-fixture'

const { storeRef } = vi.hoisted(() => {
  const storeRef: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return { storeRef }
})
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      testStore().subscribe(...args)
  }
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
import { createRuntimeFilePositionQueue } from './runtime-file-position'

const MAIN = 'repo1::/repo1/main'
const FLOATING = FLOATING_TERMINAL_WORKTREE_ID
const frames: FrameRequestCallback[] = []
let unsubs: (() => void)[] = []
let main: TabsDrawnFromMain | null = null

beforeEach(() => {
  Object.defineProperty(window, 'api', { value: createStoreSessionMockApi(), configurable: true })
  frames.length = 0
  unsubs = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  document.body.innerHTML =
    '<button id="main">Main</button><div data-floating-terminal-panel><button id="floating">Floating</button></div>'
})
afterEach(() => {
  main?.close()
  main = null
  unsubs.forEach((unsubscribe) => unsubscribe())
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})
function flushFrames(): void {
  while (frames.length) {
    frames.shift()?.(0)
  }
}
function testStore(): ReturnType<typeof createTestStore> {
  if (!storeRef.current) {
    throw new Error('Test store missing')
  }
  return storeRef.current
}
async function setup(open = true) {
  const store = createTestStore()
  storeRef.current = store
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), floatingTerminalEnabled: true },
    floatingWorkspacePath: '/tmp/floating',
    floatingWorkspacePanelOpen: open,
    worktreesByRepo: { repo1: [makeWorktree({ id: MAIN, repoId: 'repo1', path: '/repo1/main' })] }
  })
  store.getState().setActiveWorktree(MAIN)
  main = await drawTabsFromMain(store)
  const fileId = store.getState().openFile({
    filePath: '/tmp/floating/app.ts',
    relativePath: 'app.ts',
    worktreeId: FLOATING,
    language: 'typescript',
    runtimeEnvironmentId: null,
    mode: 'edit'
  })
  await main.settle()
  const position = createRuntimeFilePositionQueue(unsubs)
  return { store, fileId, position }
}
function focus(surface: 'main' | 'floating'): void {
  document.getElementById(surface)?.focus()
}

it('cancels a published reveal after an outside click even if DOM focus does not change', async () => {
  const { store, fileId, position } = await setup()
  focus('main')
  position(fileId, { line: 17 }, true)
  flushFrames()
  const reveal = store.getState().pendingEditorReveal
  expect(reveal?.canApply?.()).toBe(true)
  document.getElementById('main')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(reveal?.canApply?.()).toBe(false)
  expect(document.activeElement?.id).toBe('main')
})

it('does not reclaim input when an asynchronously revealed panel opens after an outside click', async () => {
  const { store, fileId, position } = await setup(false)
  position(fileId, { line: 17 }, true)
  document.getElementById('main')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  store.setState({ floatingWorkspacePanelOpen: true })
  flushFrames()
  expect(store.getState().pendingEditorReveal).toBeNull()
})

it('scopes the floating reveal to its selected split pane', async () => {
  const { store, fileId, position } = await setup()
  const tab = store.getState().getActiveTab(FLOATING)
  if (!tab) {
    throw new Error('Floating editor missing')
  }
  const siblingGroupId = store.getState().createEmptySplitGroup(FLOATING, tab.groupId, 'right')
  if (!siblingGroupId) {
    throw new Error('Split missing')
  }
  store.getState().createUnifiedTab(FLOATING, tab.contentType, {
    entityId: tab.entityId,
    label: tab.label,
    targetGroupId: siblingGroupId
  })
  store.getState().focusGroup(FLOATING, tab.groupId)
  position(fileId, { line: 300, column: 7 }, true)
  flushFrames()
  const reveal = store.getState().pendingEditorReveal
  expect(reveal).toMatchObject({ fileId, viewStateId: tab.id })
  expect(reveal?.canApply?.()).toBe(true)
  store.getState().focusGroup(FLOATING, siblingGroupId)
  expect(reveal?.canApply?.()).toBe(false)
})
