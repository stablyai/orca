import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEditorTabReveal } from '../../../../shared/runtime-file-contracts'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import type * as HostPersistence from '@/lib/workspace-session-host-persistence'
import {
  _resetLayoutFramePositionForTests,
  beginLayoutFramePositions,
  noteLayoutFramePosition
} from '@/runtime/layout-frame-position'

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
vi.mock('@/lib/workspace-session', () => ({ buildWorkspaceSessionPayload: vi.fn() }))
vi.mock('@/lib/workspace-session-host-persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof HostPersistence>()),
  persistWorkspaceSessionByHost: vi.fn()
}))

import { registerMobileAndTerminalCloseIpcBridge } from './mobile-terminal-close-ipc-bridge'

const WT = 'repo1::/repo1/wt'
/** A workspace only main holds: the window draws none of its tabs yet. */
const UNDRAWN = 'repo1::/repo1/undrawn'
const FILE = { filePath: '/repo1/wt/notes.md', relativePath: 'notes.md' }

function setup(): {
  reveal: (payload: RuntimeEditorTabReveal) => void
  tabId: string
  activeTabId: () => string | null | undefined
  activeWorktreeId: () => string | null
  store: ReturnType<typeof createTestStore>
} {
  let reveal: ((payload: RuntimeEditorTabReveal) => void) | undefined
  const noop = (): (() => void) => () => {}
  vi.stubGlobal('window', {
    api: {
      ...createStoreSessionMockApi(),
      ui: {
        onOpenFileFromMobile: noop,
        onOpenDiffFromMobile: noop,
        onCloseTerminal: noop,
        onSleepWorktree: noop,
        onResumeSleepingAgents: noop,
        onRevealEditorTabFromRuntime: (cb: (payload: RuntimeEditorTabReveal) => void) => {
          reveal = cb
          return () => {}
        }
      }
    }
  })
  const store = createTestStore()
  storeRef.current = store
  seedStore(store, {
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id: WT, repoId: 'repo1', path: '/repo1/wt' }),
        makeWorktree({ id: UNDRAWN, repoId: 'repo1', path: '/repo1/undrawn' })
      ]
    }
  })
  store.getState().setActiveWorktree(WT)
  store.getState().openFile({
    ...FILE,
    worktreeId: WT,
    language: 'markdown',
    runtimeEnvironmentId: null,
    mode: 'edit'
  })
  // A terminal tab in front, so showing the file's tab is visible in the selection.
  store.getState().createTab(WT)
  const fileTab = store
    .getState()
    .unifiedTabsByWorktree[WT]!.find((tab) => tab.entityId === FILE.filePath)!
  registerMobileAndTerminalCloseIpcBridge([], vi.fn())
  if (!reveal) {
    throw new Error('reveal listener was not registered')
  }
  return {
    reveal,
    tabId: fileTab.id,
    activeWorktreeId: () => store.getState().activeWorktreeId,
    store,
    activeTabId: () => {
      const state = store.getState()
      const groupId = state.activeGroupIdByWorktree[WT]
      return state.groupsByWorktree[WT]?.find((group) => group.id === groupId)?.activeTabId
    }
  }
}

afterEach(() => {
  _resetLayoutFramePositionForTests()
  vi.unstubAllGlobals()
})

describe('showing a tab main wrote for a file it opened', () => {
  it('waits for the frame that draws the tab, then shows it', () => {
    const h = setup()
    beginLayoutFramePositions()
    noteLayoutFramePosition(4)
    h.reveal({ worktreeId: WT, ...FILE, tabId: h.tabId, frameSeq: 5 })
    expect(h.activeTabId()).not.toBe(h.tabId)
    noteLayoutFramePosition(5)
    expect(h.activeTabId()).toBe(h.tabId)
  })

  it('does nothing when the tab is gone by the time its frame comes in', () => {
    const h = setup()
    const before = h.activeTabId()
    h.reveal({ worktreeId: WT, ...FILE, tabId: 'closed-tab', frameSeq: 5 })
    expect(h.activeTabId()).toBe(before)
  })

  it("visits a workspace the window has not drawn yet, then shows main's tab once it draws", async () => {
    const h = setup()
    beginLayoutFramePositions()
    // Stands in for the frame sync: once the workspace draws, its flush brings main's tab in.
    h.store.subscribe((state) => {
      if (UNDRAWN in state.groupsByWorktree && !state.unifiedTabsByWorktree[UNDRAWN]?.length) {
        queueMicrotask(() =>
          h.store.getState().createUnifiedTab(UNDRAWN, 'editor', {
            id: 'main-tab',
            entityId: '/repo1/undrawn/notes.md'
          })
        )
      }
    })
    h.reveal({ worktreeId: UNDRAWN, ...FILE, tabId: 'main-tab', navigation: 'host' })
    expect(h.activeWorktreeId()).toBe(UNDRAWN)
    // The window seeds the visited workspace's root group after render, a later task.
    await Promise.resolve()
    h.store.getState().ensureWorktreeRootGroup(UNDRAWN)
    await vi.waitFor(() => {
      const state = h.store.getState()
      const group = state.groupsByWorktree[UNDRAWN]?.find(
        (entry) => entry.id === state.activeGroupIdByWorktree[UNDRAWN]
      )
      expect(group?.activeTabId).toBe('main-tab')
      expect(state.activeTabTypeByWorktree[UNDRAWN]).toBe('editor')
    })
  })

  it('leaves an undrawn workspace unvisited for an open that does not steer this window', () => {
    const h = setup()
    h.reveal({ worktreeId: UNDRAWN, ...FILE, tabId: 'main-tab', navigation: 'caller' })
    expect(h.activeWorktreeId()).toBe(WT)
  })
})
