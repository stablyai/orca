// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'

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
import { createRuntimeFilePositionQueue } from './runtime-file-position'

const MAIN = 'repo1::/repo1/main'
const FLOATING = FLOATING_TERMINAL_WORKTREE_ID
const frames: FrameRequestCallback[] = []
let unsubs: (() => void)[] = []

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
function setup(open = true) {
  const store = createTestStore()
  storeRef.current = store
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), floatingTerminalEnabled: true },
    floatingWorkspacePath: '/tmp/floating',
    floatingWorkspacePanelOpen: open,
    worktreesByRepo: { repo1: [makeWorktree({ id: MAIN, repoId: 'repo1', path: '/repo1/main' })] }
  })
  store.getState().setActiveWorktree(MAIN)
  const fileId = store.getState().openFile({
    filePath: '/tmp/floating/app.ts',
    relativePath: 'app.ts',
    worktreeId: FLOATING,
    language: 'typescript',
    runtimeEnvironmentId: null,
    mode: 'edit'
  })
  const position = createRuntimeFilePositionQueue(unsubs)
  return { store, fileId, position }
}
function focus(surface: 'main' | 'floating'): void {
  document.getElementById(surface)?.focus()
}

it('reveals the selected floating editor without selecting its workspace in the main window', () => {
  const { store, fileId, position } = setup()
  position(fileId, { line: 300, column: 7 }, true)
  flushFrames()
  expect(store.getState().activeWorktreeId).toBe(MAIN)
  expect(store.getState().pendingEditorReveal).toMatchObject({ fileId, line: 300, column: 7 })
})

it('waits for an asynchronously revealed floating panel', () => {
  const { store, fileId, position } = setup(false)
  position(fileId, { line: 300, column: 7 }, true)
  flushFrames()
  expect(store.getState().pendingEditorReveal).toBeNull()
  store.setState({ floatingWorkspacePanelOpen: true })
  flushFrames()
  expect(store.getState().pendingEditorReveal).toMatchObject({ fileId, line: 300, column: 7 })
})

it('keeps a background floating position deferred until the panel owns keyboard input', () => {
  const { store, fileId, position } = setup()
  focus('main')
  position(fileId, { line: 17 }, false)
  flushFrames()
  expect(store.getState().pendingEditorReveal).toBeNull()
  focus('floating')
  flushFrames()
  expect(store.getState().pendingEditorReveal).toMatchObject({ fileId, line: 17 })
})

it('does not publish after keyboard input moves from the panel to the main surface', () => {
  const { store, fileId, position } = setup()
  focus('floating')
  position(fileId, { line: 17 }, true)
  focus('main')
  flushFrames()
  expect(store.getState().pendingEditorReveal).toBeNull()
  focus('floating')
  flushFrames()
  expect(store.getState().pendingEditorReveal).toMatchObject({ fileId, line: 17 })
})

it('cancels a published reveal after an outside click even if DOM focus does not change', () => {
  const { store, fileId, position } = setup()
  focus('main')
  position(fileId, { line: 17 }, true)
  flushFrames()
  const reveal = store.getState().pendingEditorReveal
  expect(reveal?.canApply?.()).toBe(true)
  document.getElementById('main')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  expect(reveal?.canApply?.()).toBe(false)
  expect(document.activeElement?.id).toBe('main')
})

it('does not reclaim input when an asynchronously revealed panel opens after an outside click', () => {
  const { store, fileId, position } = setup(false)
  position(fileId, { line: 17 }, true)
  document.getElementById('main')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  store.setState({ floatingWorkspacePanelOpen: true })
  flushFrames()
  expect(store.getState().pendingEditorReveal).toBeNull()
})

it('invalidates a published floating reveal when the panel closes or is disabled', () => {
  const { store, fileId, position } = setup()
  position(fileId, { line: 17 }, true)
  flushFrames()
  const reveal = store.getState().pendingEditorReveal
  expect(reveal?.canApply?.()).toBe(true)
  store.setState({ floatingWorkspacePanelOpen: false })
  expect(reveal?.canApply?.()).toBe(false)
  store.setState({ floatingWorkspacePanelOpen: true })
  const settings = store.getState().settings
  if (!settings) {
    throw new Error('Settings missing')
  }
  store.setState({ settings: { ...settings, floatingTerminalEnabled: false } })
  expect(reveal?.canApply?.()).toBe(false)
})

it('keeps floating input ownership independent of an unrelated main workspace selection', () => {
  const { store, fileId, position } = setup()
  focus('floating')
  position(fileId, { line: 300, column: 7 }, true)
  flushFrames()
  const reveal = store.getState().pendingEditorReveal
  expect(reveal?.canApply?.()).toBe(true)
  store.setState({ activeWorktreeId: 'other-main-workspace' })
  expect(document.activeElement?.id).toBe('floating')
  expect(reveal?.canApply?.()).toBe(true)
})

it('scopes the floating reveal to its selected split pane', () => {
  const { store, fileId, position } = setup()
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

it('disposes floating DOM listeners and invalidates an already published reveal', () => {
  const { store, fileId, position } = setup()
  position(fileId, { line: 17 }, true)
  flushFrames()
  const reveal = store.getState().pendingEditorReveal
  unsubs.forEach((unsubscribe) => unsubscribe())
  expect(reveal?.canApply?.()).toBe(false)
  focus('floating')
  flushFrames()
  expect(store.getState().pendingEditorReveal).toBe(reveal)
})
