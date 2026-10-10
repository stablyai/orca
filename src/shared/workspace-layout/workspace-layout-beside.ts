// What a stored session holds besides the layout: the desktop view's own selection, content facts
// views report, and fields this module passes through untouched. The Loader splits a session into
// these and the layout; the Serializer joins them back into today's on-disk shape.

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { BrowserWorkspace } from '../browser-workspace-types'
import type { ClosedTerminalTabTombstonesByTabId } from '../closed-terminal-tab-tombstones'
import type { TabGroup } from '../tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../terminal-tab-types'
import type { PersistedOpenFile, WorkspaceSessionState } from '../workspace-session-state-types'

type SessionFieldOwner = 'layout' | 'view' | 'fact' | 'carried' | 'legacy'

/** Every stored session field and who owns it; a new field fails typecheck until it is placed. */
export const SESSION_FIELD_OWNERS = {
  activeRepoId: 'view',
  activeWorkspaceKey: 'view',
  activeWorkspaceExecutionHostId: 'view',
  activeWorktreeId: 'view',
  activeTabId: 'view',
  tabsByWorktree: 'layout',
  terminalLayoutsByTabId: 'layout',
  localOnlyScrollbackByTabId: 'fact',
  activeWorktreeIdsOnShutdown: 'carried',
  openFilesByWorktree: 'layout',
  activeFileIdByWorktree: 'view',
  markdownFrontmatterVisible: 'view',
  browserTabsByWorktree: 'layout',
  browserPagesByWorkspace: 'fact',
  activeBrowserTabIdByWorktree: 'view',
  clientHostedBrowserPagesByWorktree: 'layout',
  clientHostedBrowserCloseIntentsByEnvironment: 'carried',
  activeTabTypeByWorktree: 'view',
  browserUrlHistory: 'carried',
  workspaceDocHistory: 'carried',
  activeTabIdByWorktree: 'view',
  unifiedTabs: 'layout',
  tabGroups: 'layout',
  tabGroupLayouts: 'layout',
  activeGroupIdByWorktree: 'view',
  activeConnectionIdsAtShutdown: 'carried',
  remoteSessionIdsByTabId: 'carried',
  lastVisitedAtByWorktreeId: 'view',
  defaultTerminalTabsAppliedByWorktreeId: 'layout',
  sleepingAgentSessionsByPaneKey: 'layout',
  terminalPtyIncarnationsByPaneKey: 'layout',
  terminalTopologyRevisionByRepoId: 'layout',
  // Applied and cleared by the Loader; never written again.
  terminalSurfaceTombstonesByPaneKey: 'legacy',
  closedTerminalTabTombstonesByTabId: 'layout'
} as const satisfies Record<keyof WorkspaceSessionState, SessionFieldOwner>

type FieldsOwnedBy<Owner extends SessionFieldOwner> = {
  [Key in keyof typeof SESSION_FIELD_OWNERS]: (typeof SESSION_FIELD_OWNERS)[Key] extends Owner
    ? Key
    : never
}[keyof typeof SESSION_FIELD_OWNERS]

export type ViewSessionField = FieldsOwnedBy<'view'>
export type FactSessionField = FieldsOwnedBy<'fact'>
export type CarriedSessionField = FieldsOwnedBy<'carried'>

export const VIEW_SESSION_FIELDS = sessionFieldsOwnedBy('view')
export const FACT_SESSION_FIELDS = sessionFieldsOwnedBy('fact')
export const CARRIED_SESSION_FIELDS = sessionFieldsOwnedBy('carried')

function sessionFieldsOwnedBy<Owner extends SessionFieldOwner>(
  owner: Owner
): FieldsOwnedBy<Owner>[] {
  const owners: Record<string, SessionFieldOwner> = SESSION_FIELD_OWNERS
  return Object.keys(owners).filter((key): key is FieldsOwnedBy<Owner> => owners[key] === owner)
}

/** The desktop window's own view record, stored in today's selection fields for downgrades. */
export type DesktopLayoutView = Pick<WorkspaceSessionState, ViewSessionField> & {
  /** Workspace key → group id. */
  groups: Record<string, Record<string, Pick<TabGroup, 'activeTabId' | 'recentTabIds'>>>
  /** Workspace key → tab id. */
  lastFocusedAt: Record<string, Record<string, number>>
  /** Terminal tab id → focused and expanded pane. */
  panes: Record<string, Pick<TerminalLayoutSnapshot, 'activeLeafId' | 'expandedLeafId'>>
  /** Workspace key → file path → unsaved draft. */
  editorDrafts: Record<string, Record<string, EditorDraft>>
}

export type EditorDraft = Pick<PersistedOpenFile, 'dirtyDraftContent' | 'lastKnownDiskSignature'>

export const EDITOR_DRAFT_FIELDS = ['dirtyDraftContent', 'lastKnownDiskSignature'] as const

export const BROWSER_TAB_LAYOUT_FIELDS = [
  'id',
  'label',
  'sessionProfileId',
  'sessionPartition',
  'pageIds',
  'createdAt'
] as const satisfies readonly (keyof BrowserWorkspace)[]

/** Fields the workspace holds once for all its records. */
export const BROWSER_TAB_WORKSPACE_FIELDS = ['worktreeId'] as const

export type BrowserTabLiveState = Omit<
  BrowserWorkspace,
  (typeof BROWSER_TAB_LAYOUT_FIELDS)[number] | (typeof BROWSER_TAB_WORKSPACE_FIELDS)[number]
>

/** A browser tab whose host view has not reported a page yet. */
export const BLANK_BROWSER_TAB_STATE: BrowserTabLiveState = {
  url: '',
  title: '',
  loading: false,
  faviconUrl: null,
  canGoBack: false,
  canGoForward: false,
  loadError: null
}

/** The row's last terminal is not a fact here: the Serializer derives it from the pane bindings. */
export type TerminalRowFacts = Pick<TerminalTab, 'title' | 'generation'>

export type PaneScrollback = { buffer?: string; scrollbackRef?: string }

/** Facts views or the PTY host report; the runtime keeps them beside the layout. */
export type LayoutContentFacts = Pick<WorkspaceSessionState, FactSessionField> & {
  /** Workspace key → tab id → tab-bar label of a non-terminal tab (a terminal's is its title). */
  tabLabels: Record<string, Record<string, string>>
  /** Terminal tab id → live title (written as row title and tab-bar label) and remount generation. */
  terminalRows: Record<string, TerminalRowFacts>
  /** Leaf id → the pane's saved scrollback. */
  scrollback: Record<string, PaneScrollback>
  /** Workspace key → browser tab id → live page state. */
  browserTabs: Record<string, Record<string, BrowserTabLiveState>>
}

export type CarriedSessionFields = Pick<WorkspaceSessionState, CarriedSessionField> & {
  /** Pane layouts with no terminal tab; kept as stored so the rules check still reports them. */
  unownedTerminalLayouts: Record<string, TerminalLayoutSnapshot>
  /** Records naming no loaded pane (or, for closed tabs, workspace), kept as stored. */
  unplacedSleepingRecords: Record<string, SleepingAgentSessionRecord>
  unplacedIncarnations: Record<string, string>
  unplacedClosedTabs: ClosedTerminalTabTombstonesByTabId
}
