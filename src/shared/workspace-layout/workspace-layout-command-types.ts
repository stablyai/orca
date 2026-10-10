// Commands a client sends to change the layout (design 2.1). The pure module applies only their
// layout effect. Refusals that need facts it does not hold stay with the runtime: an unknown
// workspace or unresolved folder home (catalog), `shell_override_refused` and
// `startup_agent_conflict` (host support), `file_outside_workspace` (paths) and
// `terminal_liveness_unavailable` (PTY host).

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { AgentType } from '../agent-status-types'
import type { AiVaultSessionTitle } from '../ai-vault-session-title'
import type { TabContentType, TabGroupLayoutNode } from '../tab-types'
import type { TerminalPaneLayoutNode, TerminalPaneSplitDirection } from '../terminal-tab-types'
import type { PaneSide } from './terminal-pane-tree'
import type { LayoutEditorFile, LayoutTerminalCreation } from './workspace-layout-model'

type On = { workspace: string }

export type LayoutCommand =
  | (On & {
      type: 'createTerminalTab'
      groupId?: string
      afterTabId?: string
      index?: number
      title?: string
      color?: string
      viewMode?: 'terminal' | 'chat'
      creation?: Partial<LayoutTerminalCreation>
    })
  | (On & {
      type: 'splitPane'
      tabId: string
      leafId: string
      direction: TerminalPaneSplitDirection
      ratio?: number
    })
  | (On & { type: 'closePane'; tabId: string; leafId: string })
  | (On & {
      type: 'closeTabs'
      tabIds: string[]
      force?: boolean
      /** The sender confirms pinned closes itself (new phones, the CLI without --force). */
      refusePinned?: boolean
      /** Editor tabs whose view reported an unsaved draft (rule 10). */
      dirtyTabIds?: string[]
    })
  | (On & { type: 'moveTab'; tabId: string; toGroupId: string; index: number })
  | (On & { type: 'splitGroup'; tabId: string; besideGroupId: string; direction: GroupSide })
  | (On & { type: 'setGroupRatios'; groupLayout: TabGroupLayoutNode })
  | (On & { type: 'setPaneRatios'; tabId: string; root: TerminalPaneLayoutNode })
  | (On & { type: 'movePane'; tabId: string; leafId: string; targetLeafId: string; side: PaneSide })
  | (On & { type: 'equalizePanes'; tabId: string })
  | (On & {
      type: 'movePaneToNewTab'
      tabId: string
      leafId: string
      groupId?: string
      index?: number
    })
  | (On & { type: 'renameTab'; tabId: string } & TabTitle)
  | (On & { type: 'renamePane'; tabId: string; leafId: string; title: string | null })
  | (On & {
      type: 'setTabProps'
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
    })
  | (On & { type: 'setChatPane'; tabId: string; leafId: string | null })
  | (On & {
      type: 'openEditorTab'
      /** The editor's file id: the tab's entity. */
      fileId: string
      contentType: Exclude<TabContentType, 'terminal' | 'browser' | 'agent-session' | 'simulator'>
      /** Present for edit-mode files, which are restored after restart. */
      file?: LayoutEditorFile
      groupId?: string
      preview?: boolean
      /** Editor tabs whose view reported an unsaved draft: a preview among them is not replaced. */
      dirtyTabIds?: string[]
    })
  | (On & { type: 'promotePreviewTab'; tabId: string })
  | (On & { type: 'openBrowserTab'; profileId?: string | null; groupId?: string })
  | (On & { type: 'openAgentSessionTab'; sessionId: string; agent: AgentType; groupId?: string })
  | (On & { type: 'startPane'; paneKey: string })
  | (On & { type: 'restartPane'; paneKey: string })
  | (On & { type: 'sleep'; paneKeys?: string[]; records: SleepingAgentSessionRecord[] })
  | (On & { type: 'wake'; paneKeys?: string[] })

export type CommandOf<T extends LayoutCommand['type']> = Extract<LayoutCommand, { type: T }>

export type GroupSide = 'left' | 'right' | 'up' | 'down'

export type TabTitle =
  | { kind: 'custom' | 'generated'; title: string | null }
  | { kind: 'aiVault'; title: AiVaultSessionTitle | null }

export type LayoutRefusalCode =
  | 'workspace_not_found'
  | 'tab_not_found'
  | 'pane_not_found'
  | 'group_not_found'
  | 'invalid_params'
  | 'group_set_changed'
  | 'pane_structure_changed'
  | 'same_pane'
  | 'last_pane'
  | 'pane_sleeping'
  | 'pane_already_bound'
  | 'workspace_exists'

/** What the runtime does after applying: stop or start terminals. The reply never waits on them. */
export type LayoutEffects = { stopPtyIds: string[]; startPaneKeys: string[] }

export type LayoutCommandResult = {
  tabId?: string
  leafId?: string
  paneKey?: string
  groupId?: string
  pageId?: string
  tabClosed?: boolean
  alreadyClosed?: boolean
  closed?: string[]
  refused?: { tabId: string; code: 'tab_pinned' | 'editor_tab_has_unsaved_draft' }[]
  slept?: string[]
  woken?: string[]
}

export type LayoutContext = {
  mintId: () => string
  /** Pane ids must be UUIDs (pane keys and PTY env carry them). */
  mintLeafId: () => string
  now: () => number
}

export type LayoutApplyResult<Model> =
  | { ok: true; model: Model; result: LayoutCommandResult; effects: LayoutEffects }
  | { ok: false; code: LayoutRefusalCode }
