import { vi } from 'vitest'
import { createUntitledMarkdownFileWithTemplateSelection } from '@/lib/create-untitled-markdown'
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
  clearEditorDraft: Mock<FloatingPanelStoreState['clearEditorDraft']>
  closeFile: Mock<FloatingPanelStoreState['closeFile']>
  closeTab: Mock<(tabId: string, options?: { reason?: string }) => void>
  closeTerminalTab: Mock<(tabId: string, options?: { onClosed?: () => void }) => void>
  closeUnifiedTab: Mock<FloatingPanelStoreState['closeUnifiedTab']>
  guardPinnedTabClose: Mock<(options: { isPinned: boolean; onClose: () => void }) => void>
  // Keep this mock loose because floating creation options exceed the store fixture’s modeled signature.
  createBrowserTab: Mock
  createTab: Mock<FloatingPanelStoreState['createTab']>
  createWebRuntimeSessionBrowserTab: Mock<(args: { worktreeId: string }) => Promise<boolean>>
  createWebRuntimeSessionTerminal: Mock<(args: { worktreeId: string }) => Promise<boolean>>
  // Keep all supported focus call arities assertable.
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
  setActiveTabType: Mock<FloatingPanelStoreState['setActiveTabType']>
  setActiveFile: Mock<FloatingPanelStoreState['setActiveFile']>
  setActiveBrowserTab: Mock<FloatingPanelStoreState['setActiveBrowserTab']>
  setActiveWorktree: Mock<FloatingPanelStoreState['setActiveWorktree']>
  focusGroup: Mock<FloatingPanelStoreState['focusGroup']>
  createEmptySplitGroup: Mock<FloatingPanelStoreState['createEmptySplitGroup']>
  openNewBrowserTabInActiveWorkspace: Mock<
    FloatingPanelStoreState['openNewBrowserTabInActiveWorkspace']
  >
  openNewMarkdownInActiveWorkspace: Mock<
    FloatingPanelStoreState['openNewMarkdownInActiveWorkspace']
  >
  openNewTerminalTabInActiveWorkspace: Mock<
    FloatingPanelStoreState['openNewTerminalTabInActiveWorkspace']
  >
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
  clearEditorDraft: vi.fn(),
  closeFile: vi.fn(),
  closeTab: vi.fn(),
  // Match real close ordering: remove from store, then notify; tests override deferred/canceled closes.
  closeTerminalTab: vi.fn((tabId: string, options?: { onClosed?: () => void }) => {
    removeFloatingTerminalTabFromStore(tabId)
    options?.onClosed?.()
  }),
  closeUnifiedTab: vi.fn(),
  // Match immediate unpinned closes; pinned confirmation remains deferred.
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
  setActiveTabType: vi.fn(),
  setActiveFile: vi.fn(),
  setActiveBrowserTab: vi.fn(),
  setActiveWorktree: vi.fn(),
  focusGroup: vi.fn(),
  createEmptySplitGroup: vi.fn(),
  openNewBrowserTabInActiveWorkspace: vi.fn(),
  openNewMarkdownInActiveWorkspace: vi.fn(),
  openNewTerminalTabInActiveWorkspace: vi.fn(),
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
  const state: FloatingPanelStoreState = {
    tabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs },
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    groupsByWorktree: {},
    unifiedTabsByWorktree: {},
    openFiles: [],
    editorBufferIdOf: {},
    editorBufferViews: {},
    activeGroupIdByWorktree: {},
    activeTabIdByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs[0]?.id ?? null },
    layoutByWorktree: {},
    expandedPaneByTabId: {},
    focusGroup: mocks.focusGroup,
    setActiveTabType: mocks.setActiveTabType,
    setActiveFile: mocks.setActiveFile,
    setActiveBrowserTab: mocks.setActiveBrowserTab,
    setActiveWorktree: mocks.setActiveWorktree,
    createEmptySplitGroup: mocks.createEmptySplitGroup,
    openNewBrowserTabInActiveWorkspace: mocks.openNewBrowserTabInActiveWorkspace,
    openNewMarkdownInActiveWorkspace: mocks.openNewMarkdownInActiveWorkspace,
    openNewTerminalTabInActiveWorkspace: mocks.openNewTerminalTabInActiveWorkspace,
    activateTab: mocks.activateTab,
    closeBrowserTab: mocks.closeBrowserTab,
    clearEditorDraft: mocks.clearEditorDraft,
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
    setTabColor: mocks.setTabColor,
    setTabPaneExpanded: mocks.setTabPaneExpanded,
    browserDefaultUrl: 'about:blank',
    keybindings: {},
    tabBarOrderByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: tabs.map((tab) => tab.id) },
    floatingWorkspacePath: null,
    // The real slice stores the host-resolved cwd; mirror the write so panes see it next render.
    setFloatingWorkspacePath: (path: string) => {
      state.floatingWorkspacePath = path
    },
    settings: { floatingTerminalCwd: '' }
  }
  storeBox.state = state
}

export function setupFloatingTerminalPanelTest(): void {
  vi.clearAllMocks()
  hookRuntime.effects = []
  hookRuntime.layoutEffects = []
  hookRuntime.index = 0
  hookRuntime.values = []
  saveDialogBox.fileId = null
  parkingBox.parkedTabIds = new Set()
  resetStore()
  // Drain singleton intents so prior tests cannot affect this render.
  consumeFloatingTerminalOpenMaximizedIntent()
  clearFloatingPanelReclaimIntent()
  mocks.setFloatingFocus = vi.fn()
  vi.mocked(createUntitledMarkdownFileWithTemplateSelection).mockReset()
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
    dispatchEvent: vi.fn(),
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
  // Provide focus/listener defaults; tests may replace activeElement while retaining effect-safe listeners.
  vi.stubGlobal('document', {
    activeElement: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  })
}
