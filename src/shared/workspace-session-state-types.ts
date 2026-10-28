import type { ExecutionHostId } from './execution-host'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { WorkspaceKey } from './folder-workspace-types'
import type { Tab, TabGroup, TabGroupLayoutNode, WorkspaceVisibleTabType } from './tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'
import type { BrowserHistoryEntry, BrowserPage, BrowserWorkspace } from './browser-workspace-types'
import type { WorkspaceDocHistoryEntry } from './workspace-doc-history'
import type { ClientHostedBrowserCloseIntent } from './client-hosted-browser-close-intent'
import type { PairedTerminalTabCloseIntent } from './paired-terminal-tab-close-intent'
import type { PersistedClientHostedBrowserPage } from './client-hosted-browser-page-record'
import type { ClosedTerminalTabTombstonesByTabId } from './closed-terminal-tab-tombstones'
import type { ClosedTerminalPanesByPaneKey } from './closed-terminal-panes'

/** Persist edit-mode files only; reconstruct transient diffs/conflicts from git state. */
export type PersistedOpenFile = {
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  isPreview?: boolean
  runtimeEnvironmentId?: string | null
  mirroredFromRuntimeSession?: true
  /** SSH target that owns an absolute path outside the worktree. */
  externalSshTargetId?: string
  /** Unsaved editor buffer captured for hot exit; presence restores the tab dirty. */
  dirtyDraftContent?: string
  /** Base disk signature for re-detecting changed-on-disk conflicts after draft restore. */
  lastKnownDiskSignature?: string
  /** Persist read-only only when true so log tabs stay read-only and older sessions stay writable. */
  readOnly?: boolean
  /** Opt-in streaming append for a read-only local log tab. */
  liveTail?: boolean
}

export type WorkspaceSessionState = {
  activeRepoId: string | null
  /** Scope-aware active owner for folder workspaces. Legacy worktree UI still reads activeWorktreeId. */
  activeWorkspaceKey?: WorkspaceKey | null
  activeWorkspaceExecutionHostId?: ExecutionHostId | null
  activeWorktreeId: string | null
  activeTabId: string | null
  /** Keys may be legacy raw worktree IDs or canonical WorkspaceKey values. */
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /** Ordinary cold-park scrollback, tabId → leafId → buffer; never leaves this client.
   * Keep separate from peer-shared layout buffers: wholesale layout copies would upload frequent hidden-workspace captures. Inventory apply rewrites layouts, leaving this home intact. Read through resolveLeafScrollbackBuffers for precedence between homes. */
  localOnlyScrollbackByTabId?: Record<string, Record<string, string>>
  /** Workspaces with live PTYs at shutdown; eagerly respawn on startup so the Active filter is immediately useful. */
  activeWorktreeIdsOnShutdown?: string[]
  /** Edit-mode files open at shutdown; transient diff/conflict views are rebuilt on demand. */
  openFilesByWorktree?: Record<string, PersistedOpenFile[]>
  /** Per-worktree active editor file ID (filePath) at shutdown. */
  activeFileIdByWorktree?: Record<string, string | null>
  /** Per-file markdown preview front-matter visibility. Absent entry means hidden. */
  markdownFrontmatterVisible?: Record<string, boolean>
  /** Persisted browser workspaces, keyed by worktree ID. */
  browserTabsByWorktree?: Record<string, BrowserWorkspace[]>
  /** Persisted browser pages, keyed by workspace ID. */
  browserPagesByWorkspace?: Record<string, BrowserPage[]>
  /** Per-worktree active browser workspace ID at shutdown. */
  activeBrowserTabIdByWorktree?: Record<string, string | null>
  /** Runtime-authoritative logical client-hosted pages; desktop browserPagesByWorkspace holds the client half. */
  clientHostedBrowserPagesByWorktree?: Record<string, PersistedClientHostedBrowserPage[]>
  /** Undelivered client-hosted page closes by runtime environment; replay on reconnect to prevent persistence resurrecting closed tabs. */
  clientHostedBrowserCloseIntentsByEnvironment?: Record<string, ClientHostedBrowserCloseIntent[]>
  /** Undelivered paired-runtime session-tab closes; replay when a host snapshot still lists the tab. */
  pairedTerminalTabCloseIntentsByEnvironment?: Record<string, PairedTerminalTabCloseIntent[]>
  /** Per-worktree active tab type (terminal vs editor vs browser) at shutdown. */
  activeTabTypeByWorktree?: Record<string, WorkspaceVisibleTabType>
  /** Global browser URL history for address bar autocomplete. */
  browserUrlHistory?: BrowserHistoryEntry[]
  /** Previewed workspace documents for the same dropdown — document identities, never URLs. */
  workspaceDocHistory?: WorkspaceDocHistoryEntry[]
  /** Per-worktree last-active terminal tab ID at shutdown. */
  activeTabIdByWorktree?: Record<string, string | null>
  /** Unified tabs take precedence on read; fall back to legacy fields when absent. */
  unifiedTabs?: Record<string, Tab[]>
  /** Tab group model — present alongside unifiedTabs. */
  tabGroups?: Record<string, TabGroup[]>
  /** Persisted split layout tree per worktree. */
  tabGroupLayouts?: Record<string, TabGroupLayoutNode>
  /** Per-worktree focused group at shutdown. */
  activeGroupIdByWorktree?: Record<string, string>
  /** SSH target IDs that were connected at shutdown. Used on startup to
   *  auto-reconnect before attempting remote PTY reattach. */
  activeConnectionIdsAtShutdown?: string[]
  /** Relay PTY session IDs captured at shutdown for startup pty.attach. */
  remoteSessionIdsByTabId?: Record<string, string>
  /** Cmd+J focus recency, distinct from background activity and navigation history (docs/cmd-j-empty-query-ordering.md). Accept missing/partial legacy maps; seed the active workspace on restore. Keys may be <hostId>|<worktreeId> or legacy bare IDs. */
  lastVisitedAtByWorktreeId?: Record<string, number>
  /** Persist default-tab admission so reopening a workspace after closing all tabs does not recreate its template. */
  defaultTerminalTabsAppliedByWorktreeId?: Record<string, true>
  /** Provider-session resume records captured when workspaces sleep. */
  sleepingAgentSessionsByPaneKey?: Record<string, SleepingAgentSessionRecord>
  /** Host-issued process incarnation for each durable terminal surface. */
  terminalPtyIncarnationsByPaneKey?: Record<string, string>
  /** Monotonic host authority watermark for terminal membership in each repo. */
  terminalTopologyRevisionByRepoId?: Record<string, number>
  /** Legacy per-surface fences migrated into terminalTopologyRevisionByRepoId on load. */
  terminalSurfaceTombstonesByPaneKey?: Record<
    string,
    {
      worktreeId: string
      parentTabId: string
      leafId: string
      ptyId: string
      incarnationId: string
      retiredAt: number
    }
  >
  /** Terminal tabs this client watched the user close, kept until the host's own snapshot stops
   *  listing them. See shared/closed-terminal-tab-tombstones.ts for why absence alone cannot say it. */
  closedTerminalTabTombstonesByTabId?: ClosedTerminalTabTombstonesByTabId
  /** Layout-owner builds: panes main's layout dropped while their terminals may run on. See
   *  shared/closed-terminal-panes.ts. */
  closedTerminalPanesByPaneKey?: ClosedTerminalPanesByPaneKey
}

export type WorkspaceSessionPatch = Partial<WorkspaceSessionState>
