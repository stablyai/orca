// Commands a client sends to change the layout (design 2.1). The pure module applies only their
// layout effect. Refusals that need facts it does not hold stay with the runtime: an unknown
// workspace or unresolved folder home (catalog), `shell_override_refused` and
// `startup_agent_conflict` (host support), `file_outside_workspace` (paths) and
// `terminal_liveness_unavailable` (PTY host).

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { AgentType } from '../agent-status-types'
import type { AiVaultSessionTitle } from '../ai-vault-session-title'
import type { EditorTabView } from '../editor-tab-view-types'
import type { TabContentType, TabGroupLayoutNode } from '../tab-types'
import type { TerminalPaneLayoutNode, TerminalPaneSplitDirection } from '../terminal-tab-types'
import type { PaneSide } from './terminal-pane-tree'
import type { PaneOutcomeChanges } from './workspace-layout-pane-outcomes'
import type { LayoutEditorFile, LayoutTerminalCreation } from './workspace-layout-model'

type On = { workspace: string }

/**
 * The desktop's drag-out rules: the terminal the window's pane shows outranks a stale binding
 * here, and a tab's last pane moves too (the window holds siblings this copy lacks).
 */
export type WindowPaneDetach = {
  ptyId: string | null
  /** The new tab's id, the same in every partition holding the pane; minted when absent. */
  tabId?: string
}

export type LayoutCommand =
  | (On & {
      type: 'createTerminalTab'
      /** Ids the runtime minted before applying, e.g. a retried create's. */
      tabId?: string
      leafId?: string
      groupId?: string
      afterTabId?: string
      index?: number
      title?: string
      color?: string
      viewMode?: 'terminal' | 'chat'
      /** When the window drew the tab, so a later save of it matches main's copy. */
      createdAt?: number
      /** A quick command tab's label, so a later save of it matches main's copy. */
      quickCommandLabel?: string
      creation?: Partial<LayoutTerminalCreation>
      initial?: InitialSurfaceReason
      split?: NewGroupSplit
    })
  | (On & {
      type: 'splitPane'
      tabId: string
      leafId: string
      direction: TerminalPaneSplitDirection
      ratio?: number
      /** The new pane's id, when the runtime minted it before applying. */
      newLeafId?: string
    })
  | (On & {
      type: 'closePane'
      tabId: string
      leafId: string
      /**
       * A user's close of one pane of a split, as the desktop's pane close: the tab's last pane is
       * refused (closing it is a tab close).
       */
      userPaneClose?: true
    })
  | (On & {
      type: 'closeTabs'
      tabIds: string[]
      force?: boolean
      /** The sender confirms pinned closes itself (new phones, the CLI without --force). */
      refusePinned?: boolean
      /** Editor tabs whose view reported an unsaved draft (rule 10). */
      dirtyTabIds?: string[]
      /**
       * Records each terminal tab closed, or not listed, as closed for this reason, so a start
       * that commits later is refused. Main sets it on a window's close.
       */
      recordClose?: 'user' | 'cleanup'
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
      /** A window's drag-out, under the desktop's move rules (WindowPaneDetach). */
      windowDetach?: WindowPaneDetach
    })
  | (On & { type: 'renameTab'; tabId: string } & TabTitle)
  | (On & { type: 'renamePane'; tabId: string; leafId: string; title: string | null })
  | (On & {
      type: 'setTabProps'
      tabId: string
      color?: string | null
      isPinned?: boolean
      viewMode?: 'terminal' | 'chat'
      /** The tab's agent launched and ended: a restore must not launch it again. */
      clearLaunchAgent?: true
    })
  | (On & { type: 'setChatPane'; tabId: string; leafId: string | null })
  | (On & {
      type: 'openEditorTab'
      /** The window's id for a tab it drew first; minted when absent. */
      tabId?: string
      /** The editor's file id: the tab's entity. */
      fileId: string
      contentType: Exclude<TabContentType, 'terminal' | 'browser' | 'agent-session' | 'simulator'>
      /** Present for edit-mode files, which are restored after restart. */
      file?: LayoutEditorFile
      /** What the tab shows beyond its file; not saved. */
      view?: EditorTabView
      groupId?: string
      preview?: boolean
      /** Editor tabs whose view reported an unsaved draft: a preview among them is not replaced. */
      dirtyTabIds?: string[]
      /** When the window drew the tab, so a later save of it matches main's copy. */
      createdAt?: number
      split?: NewGroupSplit
    })
  | (On & { type: 'promotePreviewTab'; tabId: string })
  | (On & {
      type: 'openSimulatorTab'
      /** The window's id for the tab it drew; also the tab's entity. */
      tabId: string
      groupId?: string
      /** Placement in the group: after this tab, else at this index, else at its end. */
      afterTabId?: string
      index?: number
      /** When the window drew the tab, so a later save of it matches main's copy. */
      createdAt?: number
      split?: NewGroupSplit
    })
  | (On & {
      type: 'moveTabToWorkspace'
      /** The workspace that owns the tabs' file, as the window resolved it; same partition. */
      toWorkspace: string
      /** In the order they join the group's end; ids change when they name the old owner. */
      tabs: { tabId: string; newTabId: string; newEntityId: string }[]
      groupId: string
      /** The moved edit-mode file's record in its new workspace. */
      file?: LayoutEditorFile
    })
  | (On & {
      type: 'renameEditorFiles'
      /** Under the window's ids; one workspace's files only. */
      renames: EditorFileRename[]
    })
  | (On & {
      type: 'openBrowserTab'
      profileId?: string | null
      sessionPartition?: string | null
      groupId?: string
      /** Placement in the group: after this tab, else at this index, else at its end. */
      afterTabId?: string
      index?: number
      /** The id of a page that already runs; it names the tab too, as a host's page names its row. */
      pageId?: string
      /** The window's own ids for a tab it drew: its tab-bar entry and its browser record. */
      tabId?: string
      browserTabId?: string
      /** When the window drew the tab-bar entry and the browser record, so its later save matches. */
      createdAt?: number
      browserCreatedAt?: number
      split?: NewGroupSplit
    })
  | (On & { type: 'openBrowserPage'; browserTabId: string; pageId: string })
  | (On & { type: 'closeBrowserPage'; browserTabId: string; pageId: string })
  /** A page the address bar converted: the new page takes the old one's place. */
  | (On & { type: 'replaceBrowserPage'; browserTabId: string; pageId: string; newPageId: string })
  | (On & {
      type: 'setBrowserTabProfile'
      browserTabId: string
      profileId: string | null
      sessionPartition: string | null
    })
  | (On & {
      type: 'openAgentSessionTab'
      /** The chat's own tab id, which status and attention address; minted when absent. */
      tabId?: string
      sessionId: string
      agent: AgentType
      groupId?: string
      /** Placement in the group: after this tab, else at this index, else at its end. */
      afterTabId?: string
      index?: number
      /** When the window drew the tab, so a later save of it matches main's copy. */
      createdAt?: number
      initial?: InitialSurfaceReason
      split?: NewGroupSplit
    })
  | (On & { type: 'startPane'; paneKey: string })
  | (On & { type: 'restartPane'; paneKey: string })
  | (On & {
      type: 'sleep'
      paneKeys?: string[]
      records: SleepingAgentSessionRecord[]
      /** Records how each agent resumes and stops nothing: the window's live and quit captures. */
      recordOnly?: true
    })
  /** `recordOnly`: drops the records and starts nothing. */
  | (On & { type: 'wake'; paneKeys?: string[]; recordOnly?: true })
  /** The workspace's default tabs were applied (or it had none): never apply them again. */
  | (On & { type: 'setDefaultTabsApplied' })

/**
 * Why a workspace's first surface is asked for: `restore` at relaunch, `activation` when a user
 * opens the workspace. Either is a no-op once the workspace has a tab.
 */
export type InitialSurfaceReason = 'restore' | 'activation'

export type CommandOf<T extends LayoutCommand['type']> = Extract<LayoutCommand, { type: T }>

/** One open file the window renamed or moved; `record` when it is an edit-mode file. */
export type EditorFileRename = {
  fileId: string
  newFileId: string
  record?: { fromFilePath: string; file: LayoutEditorFile }
}

export type GroupSide = 'left' | 'right' | 'up' | 'down'

/**
 * An open into a new group, named by the command's `groupId`, split off `besideGroupId`: the
 * group and its first tab are made in one step, so no empty group is ever stored. With
 * `besideLastGroupId`, the split is off the branch from `besideGroupId` to it (its first and last
 * groups), as when a group the window kept empty sits beside a branch split since.
 */
export type NewGroupSplit = {
  besideGroupId: string
  besideLastGroupId?: string
  direction: GroupSide
}

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
  | 'tab_exists'
  | 'group_exists'
  /** A window's drag-out: another tab holds the pane, or no copy binds the window's terminal. */
  | 'pane_in_other_tab'
  | 'pty_mismatch'
  | 'page_exists'

/** What the runtime does after applying: stop or start terminals. The reply never waits on them. */
export type LayoutEffects = { stopPtyIds: string[]; startPaneKeys: string[] }

export type LayoutCommandResult = {
  tabId?: string
  leafId?: string
  paneKey?: string
  groupId?: string
  pageId?: string
  /** A window's drag-out: the terminal the moved pane shows, null when unbound. */
  ptyId?: string | null
  tabClosed?: boolean
  alreadyClosed?: boolean
  closed?: string[]
  refused?: { tabId: string; code: 'tab_pinned' | 'editor_tab_has_unsaved_draft' }[]
  slept?: string[]
  woken?: string[]
  /** Old tab-bar id → new, for tabs a file rename re-ided; views move their selection with it. */
  renamedTabIds?: Record<string, string>
}

/** A command applied to a stored layout: its result, or why it changed nothing. */
export type LayoutApplyOutcome =
  | { ok: true; result: LayoutCommandResult }
  | { ok: false; code: LayoutRefusalCode }

/**
 * `layout.apply`'s reply. `host_not_owned`: a paired server owns that workspace's layout.
 * `other_partition`: a move's two workspaces are in different host partitions.
 * `wsl_move_in_progress`: a WSL move has paused the workspace (older windows log it as refused).
 * `frameSeq`: the layout stream position whose frames hold the command's effect (absent from
 * older hosts).
 */
export type LayoutApplyReply = (
  | LayoutApplyOutcome
  | { ok: false; code: 'host_not_owned' | 'other_partition' | 'wsl_move_in_progress' }
) & { frameSeq?: number }

export type LayoutContext = {
  mintId: () => string
  /** Pane ids must be UUIDs (pane keys and PTY env carry them). */
  mintLeafId: () => string
  now: () => number
  /** True while a start of this pane is in flight; such a pane is not started again. */
  isStarting?: (leafId: string) => boolean
}

export type LayoutApplyResult<Model> =
  | {
      ok: true
      model: Model
      result: LayoutCommandResult
      effects: LayoutEffects
      /** Leaf id → its new last outcome; null clears it. */
      outcomes?: PaneOutcomeChanges
    }
  | { ok: false; code: LayoutRefusalCode }
