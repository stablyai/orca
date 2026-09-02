import { vi } from 'vitest'
import type { Mock } from 'vitest'
import { consumeFloatingTerminalOpenMaximizedIntent } from '@/lib/floating-terminal'
import { clearFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import type { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { CliInstallStatus } from '../../../../shared/cli-install-types'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import {
  makeTab,
  removeFloatingTerminalTabFromStore,
  storeBox,
  type FloatingPanelStoreState
} from './floating-terminal-panel-test-fixtures'

export type EffectCallback = () => void | (() => void)

export const hookRuntime = {
  effects: [] as EffectCallback[],
  layoutEffects: [] as EffectCallback[],
  index: 0,
  values: [] as unknown[]
}

// Annotated so declaration emit never has to name vitest's internal spy types.
export type FloatingTerminalPanelMocks = {
  activateTab: Mock<FloatingPanelStoreState['activateTab']>
  activateWebRuntimeSessionTab: Mock<
    (args: { worktreeId: string; tabId: string }) => Promise<boolean>
  >
  closeBrowserTab: Mock<FloatingPanelStoreState['closeBrowserTab']>
  closeWebRuntimeSessionTab: Mock<(args: { worktreeId: string; tabId: string }) => Promise<boolean>>
  closeFile: Mock<FloatingPanelStoreState['closeFile']>
  closeTab: Mock<(tabId: string, options?: { reason?: string }) => void>
  closeTerminalTab: Mock<(tabId: string, options?: { onClosed?: () => void }) => void>
  closeUnifiedTab: Mock<FloatingPanelStoreState['closeUnifiedTab']>
  guardPinnedTabClose: Mock<(options: { isPinned: boolean; onClose: () => void }) => void>
  // Floating creates pass options the store fixture type does not model, so keep vitest's
  // default loose signature rather than narrowing call assertions.
  createBrowserTab: Mock
  createTab: Mock<FloatingPanelStoreState['createTab']>
  createWebRuntimeSessionBrowserTab: Mock<(args: { worktreeId: string }) => Promise<boolean>>
  createWebRuntimeSessionTerminal: Mock<(args: { worktreeId: string }) => Promise<boolean>>
  // Called both as focus(tabId) and focus(tabId, leafId, options); the default signature keeps
  // every arity assertable.
  focusTerminalTabSurface: Mock
  getFloatingMarkdownDirectory: Mock<() => Promise<string>>
  getFloatingTerminalCwd: Mock<() => Promise<string>>
  getInstallStatus: Mock<() => Promise<Pick<CliInstallStatus, 'pathConfigured' | 'state'>>>
  isTerminalImeInputContextRefreshing: Mock<(target: EventTarget | null) => boolean>
  isWebRuntimeSessionActive: Mock<
    (activeRuntimeEnvironmentId: string | null | undefined) => boolean
  >
  markFileDirty: Mock<FloatingPanelStoreState['markFileDirty']>
  makePreviewFilePermanent: Mock<FloatingPanelStoreState['makePreviewFilePermanent']>
  openFile: Mock<FloatingPanelStoreState['openFile']>
  pickFloatingMarkdownDocument: Mock<() => Promise<MarkdownDocument | null>>
  pinFile: Mock<FloatingPanelStoreState['pinFile']>
  setFloatingFocus: Mock<(state: { panelFocused: boolean; terminalFocused: boolean }) => void>
  setActiveTab: Mock<FloatingPanelStoreState['setActiveTab']>
  setRenamingTabId: Mock<FloatingPanelStoreState['setRenamingTabId']>
  setTabColor: Mock<FloatingPanelStoreState['setTabColor']>
  setTabCustomTitle: Mock<FloatingPanelStoreState['setTabCustomTitle']>
  setTabPaneExpanded: Mock<FloatingPanelStoreState['setTabPaneExpanded']>
  shouldDeferParkedPtyExitTabClose: Mock<(tabId: string, ptyId: string) => boolean>
  useContextualTour: Mock<typeof useContextualTour>
}

export const mocks: FloatingTerminalPanelMocks = {
  activateTab: vi.fn(),
  activateWebRuntimeSessionTab: vi.fn(),
  closeBrowserTab: vi.fn(),
  closeWebRuntimeSessionTab: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  // Models terminal-tab-actions.closeTerminalTab: a real close removes the tab from the store, then
  // runs onClosed (which arms the emptying-close reclaim intent off the now-decremented live count).
  // Pinned/cancel paths are asserted via the mock's args or overridden with mockImplementationOnce.
  closeTerminalTab: vi.fn((tabId: string, options?: { onClosed?: () => void }) => {
    removeFloatingTerminalTabFromStore(tabId)
    options?.onClosed?.()
  }),
  closeUnifiedTab: vi.fn(),
  // Models pinned-tab-close-guard.guardPinnedTabClose: unpinned closes run onClose immediately;
  // pinned closes are deferred to a confirm dialog (assert isPinned via the mock's args).
  guardPinnedTabClose: vi.fn((options: { isPinned: boolean; onClose: () => void }) => {
    if (!options.isPinned) {
      options.onClose()
    }
  }),
  createBrowserTab: vi.fn(),
  createTab: vi.fn(),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  createWebRuntimeSessionTerminal: vi.fn(),
  focusTerminalTabSurface: vi.fn(),
  getFloatingMarkdownDirectory: vi.fn(),
  getFloatingTerminalCwd: vi.fn(),
  getInstallStatus: vi.fn(),
  isTerminalImeInputContextRefreshing: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(),
  markFileDirty: vi.fn(),
  makePreviewFilePermanent: vi.fn(),
  openFile: vi.fn(),
  pickFloatingMarkdownDocument: vi.fn(),
  pinFile: vi.fn(),
  setFloatingFocus: vi.fn(),
  setActiveTab: vi.fn(),
  setRenamingTabId: vi.fn(),
  setTabColor: vi.fn(),
  setTabCustomTitle: vi.fn(),
  setTabPaneExpanded: vi.fn(),
  shouldDeferParkedPtyExitTabClose: vi.fn(),
  useContextualTour: vi.fn()
}

export const saveDialogBox = {
  fileId: null as string | null
}

export const parkingBox = {
  parkedTabIds: new Set<string>()
}

function resetStore(tabs: TerminalTab[] = []): void {
  storeBox.state = {
    tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs },
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    openFiles: [],
    activeGroupIdByWorktree: {},
    activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs[0]?.id ?? null },
    expandedPaneByTabId: {},
    renamingTabId: null,
    activateTab: mocks.activateTab,
    closeBrowserTab: mocks.closeBrowserTab,
    closeFile: mocks.closeFile,
    closeUnifiedTab: mocks.closeUnifiedTab,
    createTab: mocks.createTab,
    createBrowserTab: mocks.createBrowserTab,
    closeTab: mocks.closeTab,
    markFileDirty: mocks.markFileDirty,
    makePreviewFilePermanent: mocks.makePreviewFilePermanent,
    openFile: mocks.openFile,
    pinFile: mocks.pinFile,
    setActiveTab: mocks.setActiveTab,
    setTabCustomTitle: mocks.setTabCustomTitle,
    setRenamingTabId: mocks.setRenamingTabId,
    setTabColor: mocks.setTabColor,
    setTabPaneExpanded: mocks.setTabPaneExpanded,
    browserDefaultUrl: 'about:blank',
    keybindings: {},
    tabBarOrderByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.map((tab) => tab.id) },
    settings: { floatingTerminalCwd: '' }
  } satisfies FloatingPanelStoreState
}

// Why: the panel's per-test environment (hook runtime, store, stubbed globals and module
// singletons) is identical across every FloatingTerminalPanel behavior area.
export async function setupFloatingTerminalPanelTest(): Promise<void> {
  vi.clearAllMocks()
  hookRuntime.effects = []
  hookRuntime.layoutEffects = []
  hookRuntime.index = 0
  hookRuntime.values = []
  saveDialogBox.fileId = null
  parkingBox.parkedTabIds = new Set()
  resetStore()
  // Why: the open-maximized intent is a module singleton; drain any leftover
  // from a prior test so it cannot bleed into an unrelated render.
  consumeFloatingTerminalOpenMaximizedIntent()
  // Why: the reclaim intent is also a module singleton; clear it so one test's
  // armed-but-unconsumed intent cannot trigger a reclaim in the next.
  clearFloatingPanelReclaimIntent()
  // Why: the focus-report dedupe cache is module state keyed on the setFloatingFocus
  // mock identity; reset it so a prior test's last-reported value can't suppress an IPC.
  const { clearReportedFloatingFocusCache } = await import('./FloatingTerminalPanel')
  clearReportedFloatingFocusCache()
  mocks.createTab.mockReturnValue(makeTab({ id: 'created-tab' }))
  mocks.createWebRuntimeSessionBrowserTab.mockResolvedValue(false)
  mocks.createWebRuntimeSessionTerminal.mockResolvedValue(false)
  mocks.getFloatingMarkdownDirectory.mockResolvedValue('/tmp/orca/floating-notes')
  mocks.getFloatingTerminalCwd.mockResolvedValue('/tmp/orca')
  mocks.getInstallStatus.mockResolvedValue({ state: 'installed', pathConfigured: true })
  mocks.isTerminalImeInputContextRefreshing.mockReturnValue(false)
  mocks.isWebRuntimeSessionActive.mockReturnValue(false)
  mocks.pickFloatingMarkdownDocument.mockResolvedValue(null)
  mocks.shouldDeferParkedPtyExitTabClose.mockReturnValue(false)
  const localStorage = {
    clear: vi.fn(),
    getItem: vi.fn(() => null),
    removeItem: vi.fn(),
    setItem: vi.fn()
  }
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    api: {
      app: {
        getFloatingMarkdownDirectory: mocks.getFloatingMarkdownDirectory,
        getFloatingTerminalCwd: mocks.getFloatingTerminalCwd,
        pickFloatingMarkdownDocument: mocks.pickFloatingMarkdownDocument
      },
      browser: { notifyActiveTabChanged: vi.fn() },
      cli: { getInstallStatus: mocks.getInstallStatus },
      ui: { setFloatingFocus: mocks.setFloatingFocus }
    },
    innerHeight: 800,
    innerWidth: 1200,
    localStorage,
    requestAnimationFrame: vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }),
    removeEventListener: vi.fn()
  })
  vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('localStorage', localStorage)
  // Default so closeFloatingItemConfirmed's isFloatingWorkspacePanelFocused() read and the
  // panel's outside-pointerdown effect are both safe; individual tests override document with
  // specific activeElement state (keeping addEventListener/removeEventListener for runEffects()).
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
}
