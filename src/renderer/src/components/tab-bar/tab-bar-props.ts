import type { BrowserWorkspace } from '../../../../shared/browser/workspaces/browser-workspace-types'
import type { ClientHostedBrowserRow } from '../../../../shared/browser/client-hosting/client-hosted-browser-rows'
import type {
  Tab,
  WorkspaceVisibleTabType
} from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import type { OpenFile } from '../../store/slices/editor/types/open-file'
import type { HoveredTabInsertion } from '../tab-group/drag/tab-insertion'
import type { TabCreateEntryArgs } from './create-entry/tab-create-entry-action'
import type { NewTabMenuSurface } from '../../../../shared/new-tab-menu/new-tab-menu-layout'

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
  /** Set only when this group is one of several splits. */
  onCloseSplitPane?: () => void
  onNewTerminalTab: () => void
  onNewTerminalWithShell?: (shell: string) => void
  onNewBrowserTab: () => void
  onNewSimulatorTab?: () => void
  onOpenEntry?: (args: TabCreateEntryArgs) => Promise<void>
  terminalOnly?: boolean
  showAgentLaunchItems?: boolean
  onNewFileTab?: () => void
  onNewNamedFileTab?: () => void
  onOpenFileTab?: () => void
  /** Which + menu this is; the floating panel leads with Markdown and keeps its own layout. */
  newTabMenuSurface?: NewTabMenuSurface
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePaneExpand: (tabId: string) => void
  editorFiles?: (OpenFile & { tabId?: string })[]
  browserTabs?: (BrowserWorkspace & { tabId?: string })[]
  /** Pages rendering on a paired client. Appended after the real tabs; never part of tab order. */
  clientHostedBrowserRows?: readonly ClientHostedBrowserRow[]
  /** The group's own active tab at render time; a client-hosted selection dies when it moves. */
  groupActiveTabId?: string | null
  agentSessionTabs?: (Tab & { contentType: 'agent-session' })[]
  activeFileId?: string | null
  activeBrowserTabId?: string | null
  activeSimulatorTabId?: string | null
  activeTabType?: WorkspaceVisibleTabType
  onActivateFile?: (fileId: string) => void
  onCloseFile?: (fileId: string) => void
  onActivateBrowserTab?: (tabId: string) => void
  onActivateAgentSession?: (tabId: string) => void
  onCloseBrowserTab?: (tabId: string) => void
  onDuplicateBrowserTab?: (tabId: string, unifiedTabId: string) => void
  onCloseAllFiles?: () => void
  onMakePreviewFilePermanent?: (fileId: string, tabId?: string) => void
  onPinFile?: (fileId: string, tabId?: string) => void
  tabBarOrder?: string[]
  hoveredTabInsertion?: HoveredTabInsertion | null
  /** Floating workspace panels are rounded; skip tab top borders that clash with the curve. */
  tabStripChrome?: 'default' | 'floating-panel'
}
