import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from '@/lib/floating-terminal'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import type * as MountedTerminalTabRegistry from '@/runtime/mounted-terminal-tab-registry'
import { drawTabsFromMain } from '../../store/slices/tabs-drawn-from-main.test-fixture'

const mocks = vi.hoisted(() => {
  const store: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return {
    store,
    focusRuntimeTerminalSurface: vi.fn(() => true),
    focusTerminalTabSurface: vi.fn()
  }
})

function testStore(): ReturnType<typeof createTestStore> {
  if (!mocks.store.current) {
    throw new Error('test store not created')
  }
  return mocks.store.current
}

// Main's answer to the window's layout commands, as a switch-on build sends them.
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
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => testStore().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      testStore().setState(...args),
    subscribe: () => () => {}
  }
}))
vi.mock('@/runtime/mounted-terminal-tab-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof MountedTerminalTabRegistry>()),
  focusRuntimeTerminalSurface: mocks.focusRuntimeTerminalSurface
}))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: mocks.focusTerminalTabSurface
}))

import { registerTerminalUiRoutingIpcBridge } from './terminal-ui-routing-ipc-bridge'
import { registerTerminalPresentationIpcBridge } from './terminal-presentation-ipc-bridge'
import { registerTerminalRequestIpcBridge } from './terminal-request-ipc-bridge'
import { registerMobileAndTerminalCloseIpcBridge } from './mobile-terminal-close-ipc-bridge'
import { presentAgentLaunchTab } from '@/lib/agent-launch-tab-presentation'

const MAIN = 'repo1::/repo1/main'
const FLOATING = FLOATING_TERMINAL_WORKTREE_ID

type Listener = (payload: never) => void
/** The fields a test sends; each named bridge listener declares the full shape. */
type BridgeEventPayload = Record<string, unknown>

function setup(): {
  emit: (name: string, payload: BridgeEventPayload) => void
  dispatchEvent: ReturnType<typeof vi.fn>
  floatingTabId: string
} {
  const listeners = new Map<string, Listener>()
  const dispatchEvent = vi.fn()
  const ui = new Proxy(
    {},
    {
      get: (_target, name) =>
        typeof name === 'string' && name.startsWith('on')
          ? (listener: Listener) => {
              listeners.set(name, listener)
              return () => {}
            }
          : vi.fn()
    }
  )
  vi.stubGlobal('window', {
    dispatchEvent,
    api: { ...createStoreSessionMockApi(), ui }
  })
  const store = createTestStore()
  mocks.store.current = store
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), floatingTerminalEnabled: true },
    floatingWorkspacePath: '/tmp/floating',
    floatingWorkspacePanelOpen: false,
    worktreesByRepo: {
      repo1: [makeWorktree({ id: MAIN, repoId: 'repo1', path: '/repo1/main' })]
    }
  })
  store.getState().setActiveWorktree(MAIN)
  const floatingTabId = store.getState().createTab(FLOATING, undefined, undefined, {
    activate: false
  }).id
  store.setState({ activeView: 'terminal', pendingRevealWorktree: null })
  const unsubs: (() => void)[] = []
  registerTerminalUiRoutingIpcBridge(unsubs)
  registerTerminalPresentationIpcBridge(unsubs)
  registerTerminalRequestIpcBridge(unsubs)
  registerMobileAndTerminalCloseIpcBridge(unsubs, vi.fn())
  dispatchEvent.mockClear()
  return {
    emit: (name, payload) => {
      const listener = listeners.get(name)
      if (!listener) {
        throw new Error(`${name} was not registered`)
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each test passes the payload shape its named bridge listener declares.
      listener(payload as never)
    },
    dispatchEvent,
    floatingTabId
  }
}

/** What the main window shows; a floating reveal must leave all of it alone. */
function mainWindow(): object {
  const s = testStore().getState()
  return {
    worktree: s.activeWorktreeId,
    repo: s.activeRepoId,
    view: s.activeView,
    tab: s.activeTabId,
    tabType: s.activeTabType,
    history: s.worktreeNavHistory,
    floatingVisited: s.lastVisitedAtByWorktreeId[FLOATING],
    sidebarReveal: s.pendingRevealWorktree
  }
}

function panelToggles(dispatchEvent: ReturnType<typeof vi.fn>): number {
  return dispatchEvent.mock.calls.filter(
    ([event]) => event instanceof Event && event.type === TOGGLE_FLOATING_TERMINAL_EVENT
  ).length
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('taking the user to a floating workspace terminal', () => {
  it('terminal switch opens the panel on the tab and leaves the main window alone', () => {
    const { emit, dispatchEvent, floatingTabId } = setup()
    const before = mainWindow()

    emit('onFocusTerminal', { tabId: floatingTabId, worktreeId: FLOATING, leafId: 'leaf-1' })

    expect(mainWindow()).toEqual(before)
    expect(panelToggles(dispatchEvent)).toBe(1)
    expect(testStore().getState().activeTabIdByWorktree[FLOATING]).toBe(floatingTabId)
    expect(mocks.focusRuntimeTerminalSurface).toHaveBeenCalledWith(
      floatingTabId,
      'leaf-1',
      FLOATING
    )
  })

  it('a focused terminal create opens the panel without selecting the floating workspace', () => {
    const { emit, dispatchEvent } = setup()
    const before = mainWindow()

    emit('onCreateTerminal', { worktreeId: FLOATING, presentation: 'focused' })

    expect(mainWindow()).toEqual(before)
    expect(panelToggles(dispatchEvent)).toBe(1)
    const tabs = testStore().getState().tabsByWorktree[FLOATING] ?? []
    expect(testStore().getState().activeTabIdByWorktree[FLOATING]).toBe(tabs.at(-1)?.id)
  })

  it('a focused terminal request opens the panel without selecting the floating workspace', () => {
    const { emit, dispatchEvent } = setup()
    const before = mainWindow()

    emit('onRequestTerminalCreate', {
      requestId: 'req-1',
      worktreeId: FLOATING,
      presentation: 'focused'
    })

    expect(mainWindow()).toEqual(before)
    expect(panelToggles(dispatchEvent)).toBe(1)
  })

  it('a background create into the floating workspace does not open the panel', () => {
    const { emit, dispatchEvent } = setup()
    const before = mainWindow()

    emit('onCreateTerminal', { worktreeId: FLOATING, presentation: 'background' })
    emit('onRequestTerminalCreate', {
      requestId: 'req-2',
      worktreeId: FLOATING,
      presentation: 'background'
    })

    expect(mainWindow()).toEqual(before)
    expect(panelToggles(dispatchEvent)).toBe(0)
  })

  it('a focus-window agent launch opens the panel on its tab', () => {
    const { dispatchEvent, floatingTabId } = setup()
    const before = mainWindow()

    presentAgentLaunchTab('focus-window', FLOATING, floatingTabId)

    expect(mainWindow()).toEqual(before)
    expect(panelToggles(dispatchEvent)).toBe(1)
    expect(testStore().getState().activeTabIdByWorktree[FLOATING]).toBe(floatingTabId)
  })

  it('focusing a floating editor tab opens the panel on it', async () => {
    const { emit, dispatchEvent } = setup()
    const main = await drawTabsFromMain(testStore())
    testStore().getState().openFile(
      {
        filePath: '/tmp/floating/a.md',
        relativePath: 'a.md',
        worktreeId: FLOATING,
        language: 'markdown',
        runtimeEnvironmentId: null,
        mode: 'edit'
      },
      { selection: 'background' }
    )
    // A layout-owner build draws the editor tab from main's frame.
    await main.settle()
    main.close()
    const file = testStore()
      .getState()
      .openFiles.find((f) => f.worktreeId === FLOATING)
    const unifiedTab = (testStore().getState().unifiedTabsByWorktree[FLOATING] ?? []).find(
      (tab) => tab.entityId === file?.id
    )
    expect(unifiedTab).toBeDefined()
    testStore().getState().setActiveTabType('terminal', FLOATING)
    const before = mainWindow()

    emit('onFocusEditorTab', { tabId: unifiedTab?.id, worktreeId: FLOATING, userInitiated: true })

    expect(mainWindow()).toEqual(before)
    expect(panelToggles(dispatchEvent)).toBe(1)
    expect(testStore().getState().activeTabTypeByWorktree[FLOATING]).toBe('editor')
    expect(testStore().getState().activeFileIdByWorktree[FLOATING]).toBe(file?.id)
  })

  it('a phone opening a floating file opens the panel on it', () => {
    const { emit, dispatchEvent } = setup()
    const before = mainWindow()

    emit('onOpenFileFromMobile', {
      worktreeId: FLOATING,
      filePath: '/tmp/floating/notes.md',
      relativePath: 'notes.md'
    })

    expect(mainWindow()).toEqual(before)
    expect(panelToggles(dispatchEvent)).toBe(1)
    const file = testStore()
      .getState()
      .openFiles.find((candidate) => candidate.filePath === '/tmp/floating/notes.md')
    expect(file?.worktreeId).toBe(FLOATING)
    expect(testStore().getState().activeFileIdByWorktree[FLOATING]).toBe(file?.id)
  })
})

describe('taking the user to a folder workspace terminal', () => {
  it('terminal focus alone selects the folder workspace in the main window', () => {
    const { emit, dispatchEvent } = setup()

    emit('onFocusTerminal', { tabId: 'folder-tab', worktreeId: 'folder:fw-1', leafId: null })

    const s = testStore().getState()
    expect(s.activeWorktreeId).toBe('folder:fw-1')
    expect(s.activeWorkspaceKey).toBe('folder:fw-1')
    expect(s.activeRepoId).toBeNull()
    expect(s.worktreeNavHistory.at(-1)).toBe('folder:fw-1')
    expect(panelToggles(dispatchEvent)).toBe(0)
  })
})
