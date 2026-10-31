import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { SplitRatioIntent } from '../../../shared/workspace-layout/split-ratio-intents'
import type { PaneSide } from '../../../shared/workspace-layout/terminal-pane-tree'
import type { LayoutEditorFile } from '../../../shared/workspace-layout/workspace-layout-model'
import type { LayoutEditorView } from '../../../shared/workspace-layout/layout-editor-view'
import type { EditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'
import type {
  CommandOf,
  EditorFileRename,
  GroupSide,
  NewGroupSplit,
  TabTitle
} from '../../../shared/workspace-layout/workspace-layout-command-types'

/** What a window sends `layout.apply`; main mints any new id but one the window already drew. */
export type WindowLayoutCommand =
  | {
      type: 'splitPane'
      tabId: string
      leafId: string
      direction: 'vertical' | 'horizontal'
      /** A pane the window already split under its own id. */
      newLeafId?: string
    }
  | { type: 'closePane'; tabId: string; leafId: string }
  | { type: 'renamePane'; tabId: string; leafId: string; title: string | null }
  | { type: 'equalizePanes'; tabId: string }
  | { type: 'movePane'; tabId: string; leafId: string; targetLeafId: string; side: PaneSide }
  | { type: 'setPaneRatios'; tabId: string; ratios: SplitRatioIntent[] }
  | { type: 'setChatPane'; tabId: string; leafId: string | null }
  | {
      type: 'moveTab'
      tabId: string
      toGroupId: string
      index: number
      afterTabId?: string | null
      isPinned?: boolean
    }
  | { type: 'splitGroup'; tabId: string; besideGroupId: string; direction: GroupSide }
  | { type: 'setGroupRatios'; ratios: SplitRatioIntent[] }
  | { type: 'closeTabs'; tabIds: [string]; recordClose?: 'user' | 'cleanup' }
  | ({ type: 'renameTab'; tabId: string } & TabTitle)
  | {
      type: 'setTabProps'
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      clearLaunchAgent?: true
    }
  | {
      type: 'movePaneToNewTab'
      tabId: string
      leafId: string
      groupId: string
      index?: number
      windowDetach: { ptyId: string | null; startupCwd?: string }
    }
  | {
      type: 'openBrowserTab'
      tabId: string
      browserTabId: string
      pageId: string
      profileId: string | null
      sessionPartition: string | null
      groupId?: string
      afterTabId?: string
      index?: number
      /** Absent from a switch-on open: main stamps the tab's time. */
      createdAt?: number
      browserCreatedAt?: number
      split?: NewGroupSplit
    }
  | { type: 'openBrowserPage' | 'closeBrowserPage'; browserTabId: string; pageId: string }
  | { type: 'replaceBrowserPage'; browserTabId: string; pageId: string; newPageId: string }
  | {
      type: 'setBrowserTabProfile'
      browserTabId: string
      profileId: string | null
      sessionPartition: string | null
    }
  | {
      type: 'openEditorTab'
      tabId: string
      fileId: string
      contentType: EditorTabContentType
      file?: LayoutEditorFile
      view?: LayoutEditorView
      groupId?: string
      index?: number
      preview?: true
      /** Absent from a switch-on open: main stamps the tab's time (ledger L186). */
      createdAt?: number
      split?: NewGroupSplit
    }
  | {
      type: 'openAgentSessionTab'
      tabId: string
      sessionId: string
      agent: string
      groupId: string
      afterTabId?: string
      index?: number
      createdAt?: number
      split?: NewGroupSplit
    }
  | { type: 'promotePreviewTab'; tabId: string }
  | {
      type: 'openSimulatorTab'
      tabId: string
      groupId: string
      afterTabId?: string
      index?: number
      createdAt?: number
      split?: NewGroupSplit
    }
  | {
      type: 'moveTabToWorkspace'
      toWorkspace: string
      tabs: { tabId: string; newTabId: string; newEntityId: string; view?: LayoutEditorView }[]
      groupId: string
      file?: LayoutEditorFile
    }
  | {
      type: 'renameEditorFiles'
      renames: EditorFileRename[]
      alsoIn?: { workspace: string; renames: EditorFileRename[] }[]
    }
  | {
      type: 'sleep'
      tabId: string
      paneKeys: string[]
      records: SleepingAgentSessionRecord[]
      /** Records how the panes' agents resume without stopping them (a live or quit capture). */
      recordOnly?: true
    }
  /** Main starts the pane if its terminal is not live; the window then attaches. */
  | { type: 'startPane'; tabId: string; paneKey: string }
  | { type: 'wake'; tabId: string; paneKeys: [string] }
  /** Drops the panes' resume records without starting them. */
  | { type: 'wake'; tabId: string; paneKeys: string[]; recordOnly: true }
  | { type: 'setDefaultTabsApplied' }
  | (Omit<CommandOf<'createTerminalTab'>, 'workspace'> & { tabId: string; leafId: string })
