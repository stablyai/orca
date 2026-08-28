import type { ExecutionHostId } from './execution-host'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import type { WorkspaceKey } from './folder-workspace-types'
import type { Tab, TabGroup, TabGroupLayoutNode, WorkspaceVisibleTabType } from './tab-types'
import type { TerminalLayoutSnapshot, TerminalTab } from './terminal-tab-types'
import type { BrowserHistoryEntry, BrowserPage, BrowserWorkspace } from './browser-workspace-types'
import type { ClientHostedBrowserCloseIntent } from './client-hosted-browser-close-intent'
import type { PersistedClientHostedBrowserPage } from './client-hosted-browser-page-record'
import type { ClosedTerminalTabTombstonesByTabId } from './closed-terminal-tab-tombstones'

/** Minimal subset of OpenFile persisted across restarts.
 *  Only edit-mode files are saved — diffs, conflict reviews, and other
 *  transient views are reconstructed on demand from git state. */
export type PersistedOpenFile = {
  filePath: string
  relativePath: string
  worktreeId: string
  language: string
  isPreview?: boolean
  runtimeEnvironmentId?: string | null
  /** SSH target that owns an absolute path outside the worktree. */
  externalSshTargetId?: string
  /** Unsaved editor buffer captured for hot exit; presence restores the tab dirty. */
  dirtyDraftContent?: string
  /** Signature of the disk content the dirty draft is based on; lets restore
   *  re-derive a changed-on-disk conflict from ground truth. */
  lastKnownDiskSignature?: string
  /** Why: a read-only tab (AI Vault View Log) must survive restart still
   *  read-only; persisted only when true so old sessions stay writable. */
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
  /** Worktree IDs that had at least one tab with a live PTY at shutdown.
   *  Used on startup to eagerly re-spawn PTY processes so the Active filter
   *  works immediately after restart. */
  activeWorktreeIdsOnShutdown?: string[]
  /** Editor files that were open at shutdown, keyed by worktree ID.
   *  Only edit-mode files are persisted — diffs and conflict views are
   *  transient and not restored. */
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
  /**
   * Runtime-authored: the client-hosted logical pages this runtime owns, keyed by worktree ID.
   * Written and read only by the runtime that is the pages' authority — the desktop's own
   * `browserPagesByWorkspace` rows are the client-side half of the same tabs.
   */
  clientHostedBrowserPagesByWorktree?: Record<string, PersistedClientHostedBrowserPage[]>
  /**
   * Client-authored: closes of client-hosted pages that could not reach their owning runtime,
   * keyed by runtime environment ID. Replayed on reconnect so persistence cannot resurrect a tab
   * the user deliberately closed while the host was down.
   */
  clientHostedBrowserCloseIntentsByEnvironment?: Record<string, ClientHostedBrowserCloseIntent[]>
  /** Per-worktree active tab type (terminal vs editor vs browser) at shutdown. */
  activeTabTypeByWorktree?: Record<string, WorkspaceVisibleTabType>
  /** Global browser URL history for address bar autocomplete. */
  browserUrlHistory?: BrowserHistoryEntry[]
  /** Per-worktree last-active terminal tab ID at shutdown. */
  activeTabIdByWorktree?: Record<string, string | null>
  /** Unified tab model — present when saved by a build that includes TabsSlice.
   *  Read-path checks for this first; falls back to legacy fields if absent. */
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
  /** Maps tab IDs to their remote relay PTY session IDs. Populated at
   *  shutdown from renderer state so remote PTYs can be reattached via
   *  the relay's pty.attach RPC on startup. */
  remoteSessionIdsByTabId?: Record<string, string>
  /** Per-worktree focus-recency timestamps used by the Cmd+J empty-query
   *  ordering. Separate from worktree.lastActivityAt (background signal)
   *  and worktreeNavHistory (Back/Forward stack). See
   *  docs/cmd-j-empty-query-ordering.md. Absent in sessions written by
   *  older builds — hydration tolerates missing/partial maps and the
   *  active worktree is seeded on first restore. New host-qualified keys use
   *  `${executionHostId}|${worktreeId}`; legacy bare keys remain readable
   *  during migration and remote snapshot projection. */
  lastVisitedAtByWorktreeId?: Record<string, number>
  /** Worktrees whose repo-defined default terminal tabs have already been
   *  considered. Persisted so closing all tabs and re-opening the workspace
   *  does not recreate the template. */
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
}

export type WorkspaceSessionPatch = Partial<WorkspaceSessionState>
