// Per-execution-host layout data; view selection, content facts and drafts stay beside it. Disk-field tables assign each persisted field one source.

import type { SleepingAgentSessionRecord } from '../agent-session-resume'
import type { AgentType } from '../agent-status-types'
import type { AiVaultSessionTitle } from '../ai-vault-session-title'
import type { PersistedClientHostedBrowserPage } from '../client-hosted-browser-page-record'
import type { ClosedTerminalPanesByPaneKey } from '../closed-terminal-panes'
import type { ClosedTerminalTabTombstone } from '../closed-terminal-tab-tombstones'
import type { ExecutionHostId } from '../execution-host'
import type { TabContentType, TabGroupLayoutNode } from '../tab-types'
import type { TerminalGrid, TerminalPaneLayoutNode, TerminalTab } from '../terminal-tab-types'
import type { PersistedOpenFile } from '../workspace-session-state-types'
import type { BrowserWorkspace } from '../browser-workspace-types'
import type { LayoutEditorView } from './layout-editor-view'

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

export type LayoutTerminalCreation = Pick<
  TerminalTab,
  'defaultTitle' | 'shellOverride' | 'forceHostRuntime' | 'startupCwd' | 'launchAgent'
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

export type LayoutClosedTab = Omit<ClosedTerminalTabTombstone, 'worktreeId'>

/** Key pane data by partition-unique leaf ID so moving a pane does not move its records. */
export type LayoutLeaf = {
  /** Absent while unbound. */
  ptyId?: string
  /** Rises on each pty bind, retire and rollback of this pane in this process. In memory only. */
  ptyGeneration?: number
  incarnationId?: string
  title?: string
  /** Last grid used to size the terminal at startup. */
  lastGrid?: TerminalGrid
  /** Slept pane record; mutually exclusive with resume. */
  sleeping?: LayoutSleepingRecord
  /** Running-agent resume record (live/quit origin); mutually exclusive with sleeping. */
  resume?: LayoutSleepingRecord
}

export type WorkspaceLayout = {
  /** Every persisted record names this worktree or folder ID. */
  worktreeId: string
  /** Storage order only; groups define display order. */
  tabs: LayoutTab[]
  /** Groups define the sole tab order and close when empty. */
  groups: LayoutGroup[]
  groupLayout?: TabGroupLayoutNode
  editorFiles?: LayoutEditorFile[]
  /** Tab id → what an editor tab shows beyond its file (diff, conflict, preview…). The view is not saved. */
  editorViews?: Record<string, LayoutEditorView>
  browserTabs?: LayoutBrowserTab[]
  /** Leaf ID → pane data. */
  leaves?: Record<string, LayoutLeaf>
  /** Tab ID → closed terminal record. */
  closedTerminalTabs?: Record<string, LayoutClosedTab>
}

export type WorkspaceLayoutRecords = {
  defaultTabsAppliedByWorkspace?: Record<string, true>
  clientHostedBrowserPagesByWorkspace?: Record<string, PersistedClientHostedBrowserPage[]>
  /** Panes main dropped while their terminals may run on (layout-owner builds). */
  closedTerminalPanesByPaneKey?: ClosedTerminalPanesByPaneKey
}

/** What only older builds read from today's documents; the layout never reads it back. */
export type LegacyLayoutPersistence = {
  /** Owned workspaces retain a row list even when empty. Absence may mean another partition owns the rows. */
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

export function tabsInOrder(workspace: WorkspaceLayout): LayoutTab[] {
  const byId = new Map(workspace.tabs.map((tab) => [tab.id, tab]))
  return workspace.groups.flatMap((group) => group.tabOrder.flatMap((id) => byId.get(id) ?? []))
}
