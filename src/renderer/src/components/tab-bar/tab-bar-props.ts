import type {
  BrowserTab as BrowserTabState,
  TerminalTab,
  WorkspaceVisibleTabType
} from '../../../../shared/types'
import type { OpenFile } from '../../store/slices/editor'
import type { HoveredTabInsertion } from '../tab-group/useTabDragSplit'
import type { TabCreateEntryArgs } from './tab-create-entry-action'

export type TabBarProps = {
  tabs: (TerminalTab & { unifiedTabId?: string })[]
  activeTabId: string | null
  groupId?: string
  worktreeId: string
  expandedPaneByTabId: Record<string, boolean>
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onCloseToLeft: (tabId: string) => void
  onNewTerminalTab: () => void
  /** On Windows, opens a new terminal with a specific shell instead of the default. */
  onNewTerminalWithShell?: (shell: string) => void
  onNewBrowserTab: () => void
  onNewSimulatorTab?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  terminalOnly?: boolean
  showAgentLaunchItems?: boolean
  onNewFileTab?: () => void
  onOpenFileTab?: () => void
  newTabMenuOrder?: 'default' | 'markdown-first'
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  editorFiles?: (OpenFile & { tabId?: string })[]
  browserTabs?: (BrowserTabState & { tabId?: string })[]
  activeFileId?: string | null
  activeBrowserTabId?: string | null
  activeSimulatorTabId?: string | null
  activeTabType?: WorkspaceVisibleTabType
  onActivateFile?: (fileId: string) => void
  onCloseFile?: (fileId: string) => void
  onActivateBrowserTab?: (tabId: string) => void
  onCloseBrowserTab?: (tabId: string) => void
  onDuplicateBrowserTab?: (tabId: string) => void
  onCloseAllFiles?: () => void
  onMakePreviewFilePermanent?: (fileId: string, tabId?: string) => void
  onPinFile?: (fileId: string, tabId?: string) => void
  tabBarOrder?: string[]
  hoveredTabInsertion?: HoveredTabInsertion | null
  /** Floating workspace panels are rounded; skip tab top borders that clash with the curve. */
  tabStripChrome?: 'default' | 'floating-panel'
}
