// The one workspace tab layout model the runtime holds, per execution-host partition. Pure data:
// per-view selection, content facts (live titles, page state, scrollback) and drafts live beside it
// (workspace-layout-beside.ts), never in it. Each on-disk field is written from exactly one field
// here or beside it (workspace-layout-disk-fields.ts).

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { AgentType } from '../agent-status-types'
import type { AiVaultSessionTitle } from '../ai-vault-session-title'
import type { PersistedClientHostedBrowserPage } from '../client-hosted-browser-page-record'
import type { ClosedTerminalTabTombstone } from '../closed-terminal-tab-tombstones'
import type { ExecutionHostId } from '../execution-host'
import type { TabContentType, TabGroupLayoutNode } from '../tab-types'
import type { TerminalPaneLayoutNode, TerminalTab } from '../terminal-tab-types'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import type { BrowserWorkspace } from '../browser-workspace-types'

export type LayoutTerminalPanes = {
  root: TerminalPaneLayoutNode | null
  chatLeafId?: string
}

type LayoutTabFields = {
  /** Tab-bar id. Terminal pane keys, layouts and records use `entityId`. */
  id: string
  entityId: string
  createdAt: number
  customTitle: string | null
  generatedTitle?: string | null
  aiVaultTitle?: AiVaultSessionTitle | null
  quickCommandLabel?: string | null
  color: string | null
  isPinned?: boolean
  viewMode?: 'terminal' | 'chat'
  isPreview?: boolean
  agentSessionAgent?: AgentType
}

/** Creation fields only a terminal tab carries. */
export type LayoutTerminalCreation = Pick<
  TerminalTab,
  | 'defaultTitle'
  | 'shellOverride'
  | 'forceHostRuntime'
  | 'startupCwd'
  | 'launchAgent'
  | 'agentLaunchPane'
>

export type LayoutTerminalTab = LayoutTabFields & {
  kind: 'terminal'
  terminal: LayoutTerminalCreation
  panes: LayoutTerminalPanes
}

export type LayoutContentTab = LayoutTabFields & { kind: Exclude<TabContentType, 'terminal'> }

export type LayoutTab = LayoutTerminalTab | LayoutContentTab

export type LayoutGroup = { id: string; tabOrder: string[] }

/** An open editor file minus its unsaved draft (the view's) and what its tab and workspace hold. */
export type LayoutEditorFile = Omit<
  PersistedOpenFile,
  'dirtyDraftContent' | 'lastKnownDiskSignature' | 'isPreview' | 'worktreeId'
>

/** A browser tab minus the live page state its host view reports. */
export type LayoutBrowserTab = Pick<
  BrowserWorkspace,
  'id' | 'label' | 'sessionProfileId' | 'sessionPartition' | 'pageIds' | 'createdAt'
>

/** A sleeping agent record minus what its pane key and workspace already say. */
export type LayoutSleepingRecord = Omit<
  SleepingAgentSessionRecord,
  'paneKey' | 'tabId' | 'worktreeId'
>

/** A closed terminal tab record minus its workspace. */
export type LayoutClosedTab = Omit<ClosedTerminalTabTombstone, 'worktreeId'>

/** One pane's own data. Kept by leaf id (unique in the partition), so a moved pane moves nothing. */
export type LayoutLeaf = {
  /** The terminal it shows; absent while unbound. */
  ptyId?: string
  incarnationId?: string
  /** User pane title. */
  title?: string
  sleeping?: LayoutSleepingRecord
}

export type WorkspaceLayout = {
  /** The worktree or folder id every record of this workspace names on disk. */
  worktreeId: string
  /** Every tab of the workspace, all kinds. The order of this list is storage only. */
  tabs: LayoutTab[]
  /** `tabOrder` here is the one tab order. A group never stays empty: an empty one is closed. */
  groups: LayoutGroup[]
  groupLayout?: TabGroupLayoutNode
  editorFiles?: LayoutEditorFile[]
  browserTabs?: LayoutBrowserTab[]
  /** Leaf id → the data of a pane of one of this workspace's terminal tabs. */
  leaves?: Record<string, LayoutLeaf>
  /** Tab id → a terminal tab closed in this workspace. */
  closedTerminalTabs?: Record<string, LayoutClosedTab>
}

export type WorkspaceLayoutRecords = {
  defaultTabsAppliedByWorkspace?: Record<string, true>
  clientHostedBrowserPagesByWorkspace?: Record<string, PersistedClientHostedBrowserPage[]>
}

/** What only older builds read from today's documents; the layout never reads it back. */
export type LegacyLayoutPersistence = {
  /**
   * Workspace key → this partition owns the workspace's terminal rows, saved as a row list even
   * when empty (partitionOwnsWorktreeTabs). Absent is not empty: another partition may own them.
   */
  terminalRowOwners: Record<string, true>
  /** Advanced when terminal panes change so an older build's save merge defers to this layout. */
  topologyRevisionByRepoId?: Record<string, number>
}

export type WorkspaceLayoutModel = {
  hostId: ExecutionHostId
  /** Keyed by the session key as stored (legacy worktree id or workspace key). */
  workspaces: Record<string, WorkspaceLayout>
  records: WorkspaceLayoutRecords
  legacy: LegacyLayoutPersistence
}

// Disk and wire key only: legacy leaf ids are not UUIDs, so makePaneKey would throw on them.
export function paneKeyOf(terminalTabId: string, leafId: string): string {
  return `${terminalTabId}:${leafId}`
}

/** The workspace's tabs in the one tab order. */
export function tabsInOrder(workspace: WorkspaceLayout): LayoutTab[] {
  const byId = new Map(workspace.tabs.map((tab) => [tab.id, tab]))
  return workspace.groups.flatMap((group) => group.tabOrder.flatMap((id) => byId.get(id) ?? []))
}
