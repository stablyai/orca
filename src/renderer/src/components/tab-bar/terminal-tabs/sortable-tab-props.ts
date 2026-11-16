import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import type { TerminalAgent } from '../../../../../shared/agent-status/identity/terminal-agent'
import type { TabDragItemData } from '../../tab-group/drag/tab-drag-data'
import type { DropIndicator } from '../strip/drop-indicator'
import type { NativeChatTabSession } from '../session-actions/tab-session-history-switch'
import type { StructuredChatTabNamingFailure } from '@/runtime/native-chat/naming/structured-conversation-name'

/** What the strip draws for a terminal or native chat tab; never a source of agent identity. */
type SortableTabModel = Pick<
  TerminalTab,
  'id' | 'worktreeId' | 'title' | 'customTitle' | 'color' | 'shellOverride' | 'launchAgent'
>

export type SortableTabProps = {
  tab: SortableTabModel
  /** The tab's agent, resolved by the caller from its own source of truth (pane signals or the chat's provider). */
  agent: TerminalAgent | null
  unifiedTabId: string
  groupId: string
  tabCount: number
  hasTabsToRight: boolean
  hasTabsToLeft: boolean
  isActive: boolean
  isPinned: boolean
  isExpanded: boolean
  onActivate: (tabId: string) => void
  onClose: (tabId: string) => void
  onCloseOthers: (tabId: string) => void
  onCloseToRight: (tabId: string) => void
  onCloseToLeft: (tabId: string) => void
  onCloseSplitPane?: () => void
  onSetCustomTitle: (tabId: string, title: string | null) => void
  onSetTabColor: (tabId: string, color: string | null) => void
  onTogglePin: () => void
  onToggleExpand: (tabId: string) => void
  dragData: TabDragItemData
  dropIndicator?: DropIndicator
  includeTopTabBorder?: boolean
  /** True when this agent terminal can switch between the terminal and native chat views; surfaces the "Switch view" context-menu item. */
  canToggleViewMode?: boolean
  isChatView?: boolean
  onToggleViewMode?: () => void
  canSplitTerminal?: boolean
  nativeChat?: NativeChatTabSession
  /** A native chat whose generated name failed, unless the user named the tab. */
  namingFailure?: StructuredChatTabNamingFailure | null
  /** A forked chat: the title carries the fork mark; the hover card names the source. */
  fork?: { describeSource: () => string; markedTitle: string }
}
