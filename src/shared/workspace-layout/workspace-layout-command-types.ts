// Pure commands change layout only; runtime owns catalog/path/host-support/liveness refusals requiring external facts.

import type { LiveTerminalAdoption } from './workspace-layout-terminal-adoption'
import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { AgentType } from '../agent-status-types'
import type { AiVaultSessionTitle } from '../ai-vault-session-title'
import type { LiveSurfaceContentType, TabContentType, TabGroupLayoutNode } from '../tab-types'
import type {
  TerminalGrid,
  TerminalPaneLayoutNode,
  TerminalPaneSplitDirection
} from '../terminal-tab-types'
import type { PaneSide } from './terminal-pane-tree'
import type { SplitRatioIntent } from './split-ratio-intents'
import type { PaneOutcomeChanges } from './workspace-layout-pane-outcomes'
import type { LayoutEditorView } from './layout-editor-view'
import type { LayoutEditorFile, LayoutTerminalCreation } from './workspace-layout-model'

type On = { workspace: string }

/** Desktop drag-out trusts the displayed PTY over stale bindings and permits moving the last known pane because the window may hold unseen siblings. */
export type WindowPaneDetach = {
  ptyId: string | null
  /** The new tab's id, the same in every partition holding the pane; minted when absent. */
  tabId?: string
  /** The pane's folder, for the shell an unbound pane starts in its new tab. Older mains drop it. */
  startupCwd?: string
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
      /** A live terminal no pane shows: its pane when main holds one, else this tab, bound to it. */
      adopt?: LiveTerminalAdoption
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
      /** A user split-pane close refuses the last pane; that requires tab-close intent. */
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
      /** Record closed or missing terminal tabs so a later in-flight start cannot commit after a window close. */
      recordClose?: 'user' | 'cleanup'
    })
  | (On & {
      type: 'moveTab'
      tabId: string
      toGroupId: string
      index: number
      /** Right after this tab (null: first) when it is in the target group; else `index`. */
      afterTabId?: string | null
      /** Pins or unpins the tab where `index` puts it, in the same step. */
      isPinned?: boolean
    })
  | (On & { type: 'splitGroup'; tabId: string; besideGroupId: string; direction: GroupSide })
  /** `ratios`, or from a window older than them, `groupLayout`: exactly one. */
  | (On & {
      type: 'setGroupRatios'
      groupLayout?: TabGroupLayoutNode
      ratios?: SplitRatioIntent[]
    })
  /** `ratios`, or from a window older than them, `root`: exactly one. */
  | (On & {
      type: 'setPaneRatios'
      tabId: string
      root?: TerminalPaneLayoutNode
      ratios?: SplitRatioIntent[]
    })
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
  /** Main only: the grid the pane's terminal was last sized to, which a restart starts it at. */
  | (On & { type: 'setPaneGrid'; tabId: string; leafId: string; grid: TerminalGrid })
  /** Main only: unbinds the pane from `ptyId` if it still names it, stopping nothing. */
  | (On & { type: 'releasePaneTerminal'; tabId: string; leafId: string; ptyId: string })
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
      /** Main-only opens may derive file ID; wire commands must still provide it. */
      fileId?: string
      contentType: Exclude<
        TabContentType,
        'terminal' | 'browser' | 'agent-session' | 'simulator' | 'desktop-app'
      >
      /** Present for edit-mode files, which are restored after restart. */
      file?: LayoutEditorFile
      /** What the tab shows beyond its file; not saved. */
      view?: LayoutEditorView
      groupId?: string
      /** Placement in the group: at this index, else at its end. */
      index?: number
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
      /** Which live-surface tab; absent means 'simulator' (older windows). */
      kind?: LiveSurfaceContentType
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
      /** Rekey tabs that name the old owner and retarget nonplain views to the new file owner, preserving join order. */
      tabs: { tabId: string; newTabId: string; newEntityId: string; view?: LayoutEditorView }[]
      groupId: string
      /** The moved edit-mode file's record in its new workspace. */
      file?: LayoutEditorFile
    })
  | (On & {
      type: 'renameEditorFiles'
      /** Under the window's ids; one workspace's files only. */
      renames: EditorFileRename[]
      /** Other workspaces' renames of the same disk move: all are applied, or none. */
      alsoIn?: { workspace: string; renames: EditorFileRename[] }[]
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
  /** Starts the slept panes, which keep their records. `recordOnly`: drops them, starts nothing. */
  | (On & { type: 'wake'; paneKeys?: string[]; recordOnly?: true })
  /** The workspace's default tabs were applied (or it had none): never apply them again. */
  | (On & { type: 'setDefaultTabsApplied' })
  /** A workspace's default terminal tabs, in order, and the mark: nothing once it is marked. */
  | (On & { type: 'applyDefaultTabs'; tabs: DefaultTerminalTab[] })

/** Restore/activation may request the first surface; both become no-ops once any tab exists. */
export type InitialSurfaceReason = 'restore' | 'activation'

/** The ids are the window's: it keys its spawn inputs by them before main answers. */
export type DefaultTerminalTab = {
  tabId: string
  leafId: string
  title?: string
  color?: string
  creation?: Partial<LayoutTerminalCreation>
}

export type CommandOf<T extends LayoutCommand['type']> = Extract<LayoutCommand, { type: T }>

/** One open file the window renamed or moved; `record` when it is an edit-mode file. */
export type EditorFileRename = {
  fileId: string
  newFileId: string
  record?: { fromFilePath: string; file: LayoutEditorFile }
  /** A non-plain tab's view under the file's new path. */
  view?: LayoutEditorView
}

export type GroupSide = 'left' | 'right' | 'up' | 'down'

/** Create a split group and its first tab atomically, never storing an empty group.
 * An optional last-group ID expands the target to a branch, supporting window-retained empty groups beside later splits. */
export type NewGroupSplit = {
  besideGroupId: string
  besideLastGroupId?: string
  direction: GroupSide
}

export type TabTitle =
  /** A generated title replaces the tab's existing one only with `replaceExisting`: first wins. */
  | {
      kind: 'custom' | 'generated'
      title: string | null
      replaceExisting?: true
      expected?: { entityId: string; executionHostId: string; customTitle: string }
    }
  | { kind: 'aiVault'; title: AiVaultSessionTitle | null }

/** One tab's agent-generated title in a `renameTabs` batch. */
export type GeneratedTabTitle = {
  workspace: string
  tabId: string
  title: string | null
  replaceExisting?: true
}

/** Batch cross-workspace generated titles in one write/frame; each entry follows renameTab semantics. */
export type RenameTabsCommand = {
  type: 'renameTabs'
  kind: 'generated'
  renames: GeneratedTabTitle[]
}

/** A `renameTabs` title main did not give its tab, and why. */
export type UntitledTab = Omit<GeneratedTabTitle, 'title' | 'replaceExisting'> & {
  code: Extract<LayoutApplyReply, { ok: false }>['code']
}

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
  /** Sent by older hosts only: a startPane of an unbound pane with a sleeping record. */
  | 'pane_sleeping'
  | 'pane_already_bound'
  | 'workspace_exists'
  | 'tab_exists'
  /** A create under a tab id main recorded closed, or a pane id it closed: a resend after the close. */
  | 'tab_closed'
  | 'group_exists'
  /** A window's drag-out: another tab holds the pane, or no copy binds the window's terminal. */
  | 'pane_in_other_tab'
  | 'pty_mismatch'
  | 'page_exists'
  /** A generated title without `replaceExisting` for a tab that has one: main keeps the first. */
  | 'generated_title_kept'

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
  /** `renameTabs`: the titles main did not give; every other tab has its title. */
  untitled?: UntitledTab[]
  /** Tabs one command made, in order (`applyDefaultTabs`). */
  createdTabs?: { tabId: string; leafId: string; paneKey: string }[]
}

/** A command applied to a stored layout: its result, or why it changed nothing. */
export type LayoutApplyOutcome =
  | { ok: true; result: LayoutCommandResult }
  | { ok: false; code: LayoutRefusalCode }

/** Refuse foreign ownership/partition moves and paused WSL moves; older windows log pauses as refusals.
 * Optional frameSeq identifies the stream position holding the effect; older hosts omit it. */
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
  /** Why panes this commit drops are closed: only a live edit's drops run the dropped-leaf step.
   *  Absent (load, restore, peer merge, moves) records nothing. */
  droppedLeafReason?: DroppedLeafReason
  /** Missing callback means live; dead/start-status bindings instead identify what a pane restores from. */
  isBindingLive?: (paneKey: string, ptyId: string) => boolean
  /** Whether the live bound terminal is an empty shell a hibernated agent left: startPane replaces it. */
  retiresBinding?: (paneKey: string, ptyId: string) => boolean
}

export type DroppedLeafReason = 'live-edit'

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
