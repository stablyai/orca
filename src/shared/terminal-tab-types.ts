import type { AiVaultSessionTitle } from './ai-vault-session-title'
import type { TuiAgent } from './tui-agent'

/** Why recovery reasons live in the shared row type: the tab row carries the
 *  recovery ledger, and the ledger records which reason it last acted on. */
export type TerminalPaneRecoveryReason =
  | 'write-stalled'
  | 'replay-wedged'
  | 'input-undeliverable'
  // The paired runtime that owns the PTY refused this write and said so on the
  // wire. Distinct from 'input-undeliverable' because it skips the liveness
  // probe: main's registry holds no entry for a `remote:` id, so `pty:hasPty`
  // routes it to the local provider and answers a fabricated "dead". The
  // rejection frame is the evidence instead — it came from the process that
  // owns the PTY, over a connection that is by construction still up.
  | 'input-rejected-by-host'
  | 'reattach-unverifiable'
  // A restore was requested for a certified-dead pipeline (reveal path).
  | 'restore-blocked'
  // A spawn resolved without a PTY id, so the pane is mounted with no transport
  // binding. pty:data for the old id then lands in the pre-handler buffer, which
  // ACKs it — main's delivery health stays green while the pane shows nothing.
  | 'spawn-left-pane-unbound'

/** Same vocabulary the direct-SSH pane retry ledger settles with
 *  (DirectSshPaneRetryResult), so a pane reports both through one call. */
export type TerminalPaneRecoveryOutcome =
  | 'pending'
  | 'success'
  | 'failed'
  | 'timed-out'
  | 'superseded'

/** The tab's recovery ledger. Lives on the row — not in a module- or
 *  store-level map keyed by tabId — so a tab's existence and its recovery
 *  budget are the same object: nothing can release the budget while keeping
 *  the row, and closing the tab drops both together (crash b5cfc6ca). */
export type TerminalTabRecoveryLedger = {
  /** Remount timestamps inside the rolling window. Backstop, not the control. */
  attemptedAt: number[]
  /** Recovery epoch. A mounted pane captures it and stale requests are refused. */
  generation: number
  /** What the mounted pane observed for the attempt this ledger describes. */
  outcome: TerminalPaneRecoveryOutcome
  /** When that attempt was requested. Bounds how long 'pending' may block. */
  startedAt: number
  /** The reason this attempt acted on. A settled failure refuses the SAME
   *  reason again until a new trigger arrives. */
  reason: TerminalPaneRecoveryReason
  /** `tab.generation` right after the remount. Any later bump — authority
   *  change, SSH pane retry, activation respawn — is a new trigger, so the
   *  mismatch alone supersedes this ledger. No writer required. */
  tabGeneration: number
}

// ─── Terminal Tab (legacy — used by persistence and TerminalContentSlice) ─
export type TerminalTab = {
  id: string
  ptyId: string | null
  worktreeId: string
  title: string
  /** Stable fallback label for default-named terminals ("Terminal 1", etc.).
   *  Why: agent CLIs overwrite the live title via OSC updates, but Orca still
   *  needs the original terminal label for numbering and reset behavior. */
  defaultTitle?: string
  /** Stable opt-in label derived from the first known agent prompt. */
  generatedTitle?: string | null
  /** Stable AI Vault conversation name, bound to its provider session identity. */
  aiVaultTitle?: AiVaultSessionTitle | null
  /** Stable label from the tab-bar Quick Command that created this terminal. */
  quickCommandLabel?: string | null
  customTitle: string | null
  color: string | null
  /** Pinned tabs survive "close others"; host-persisted for remote servers. */
  isPinned?: boolean
  /** Per-tab view preference (terminal xterm vs native chat); host-persisted so
   *  paired clients converge. Optional: older persisted tabs default to 'terminal'. */
  viewMode?: 'terminal' | 'chat'
  sortOrder: number
  createdAt: number
  /** Bumped on shutdown so TerminalPane remounts with a fresh PTY. */
  generation?: number
  /** Why: records the shell this tab was opened with (e.g. 'wsl.exe') so the
   *  PTY and tab icon stay stable even if the default shell setting changes
   *  later. Older persisted tabs may omit this field. */
  shellOverride?: string
  /** Keeps an ephemeral host fallback out of the active project's runtime. */
  forceHostRuntime?: boolean
  /** Why: explorer-created terminals can start below the workspace root while
   *  still belonging to that workspace for tab/session ownership. */
  startupCwd?: string
  /** Why: the coding-harness agent Orca launched in this tab. Lets the tab bar
   *  show the provider icon immediately, before the agent emits its first hook
   *  event (a freshly-launched, idle agent reports no live status yet). Live
   *  hook status overrides this once the agent does anything. Plain terminals
   *  and manually-started agents omit it. */
  launchAgent?: TuiAgent
  /** Why: when `setActiveWorktree` bumps generation on all-dead tabs to drive a
   *  TerminalPane remount, the fresh PTY that results is caused by navigation,
   *  not by the user doing work. Without this flag the resulting
   *  `updateTabPtyId` call would call `bumpWorktreeActivity` and flip the
   *  sidebar's recency sort on every click — the reorder-on-click bug. The
   *  flag is set by `setActiveWorktree` and consumed by the activation-driven
   *  PTY lifecycle calls that follow, which then suppress activity bumps and
   *  `sortEpoch` increments. Split layouts use a numeric count because one tab
   *  can remount several panes. Never persisted — it is a transient handoff. */
  pendingActivationSpawn?: boolean | number
  /** Transient recovery ledger for this tab. Never persisted — it describes a
   *  mounted pane's in-flight heal, and a stale one would refuse the first
   *  legitimate recovery after restart. Stripped exactly like
   *  `pendingActivationSpawn` (buildSanitizedTabsByWorktree). */
  recovery?: TerminalTabRecoveryLedger
}

export type TerminalPaneSplitDirection = 'vertical' | 'horizontal'

export type TerminalPaneLayoutNode =
  | {
      type: 'leaf'
      leafId: string
    }
  | {
      type: 'split'
      direction: TerminalPaneSplitDirection
      first: TerminalPaneLayoutNode
      second: TerminalPaneLayoutNode
      /** Flex ratio of the first child (0–1). Defaults to 0.5 if absent. */
      ratio?: number
    }

export type TerminalLayoutSnapshot = {
  root: TerminalPaneLayoutNode | null
  activeLeafId: string | null
  expandedLeafId: string | null
  /** Live PTY IDs per leaf for in-session remounts such as tab-group moves.
   *  Not used for app restart because PTYs are transient processes. */
  ptyIdsByLeafId?: Record<string, string>
  /** Serialized terminal buffers per leaf for scrollback restoration on restart. */
  buffersByLeafId?: Record<string, string>
  /** Durable scrollback snapshot refs per leaf; raw bytes live outside session JSON. */
  scrollbackRefsByLeafId?: Record<string, string>
  /** User-assigned pane titles, keyed by stable layout leaf UUID.
   *  Persisted alongside buffers via the existing session:set flow. */
  titlesByLeafId?: Record<string, string>
}
