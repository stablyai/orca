import type { AiVaultSessionTitle } from './ai-vault-session-title'
import type { TuiAgent } from './tui-agent'
import type { AgentLaunchPaneOutcome } from './agent-launch-pane-verdict'

/** The tab row owns the recovery ledger, including the last reason it acted on. */
export type TerminalPaneRecoveryReason =
  | 'write-stalled'
  | 'replay-wedged'
  | 'input-undeliverable'
  // A paired host explicitly refused input. Skip local liveness probing: remote IDs have no local registry entry and would falsely read as dead.
  | 'input-rejected-by-host'
  | 'reattach-unverifiable'
  // A restore was requested for a certified-dead pipeline (reveal path).
  | 'restore-blocked'
  // A spawn with no PTY leaves no renderer binding; old-ID output can still be ACKed by the pre-handler buffer, hiding the blank pane from delivery health.
  | 'spawn-left-pane-unbound'
  // A pane ended on its host's exit record, then the host bound a new process to it.
  | 'host-rebound-exited-pane'

export type TerminalPaneRecoveryOutcome =
  | 'pending'
  | 'success'
  | 'failed'
  | 'timed-out'
  | 'superseded'

/** Keep the ledger on the tab row so recovery budget cannot disappear while the tab survives; closing drops both (crash b5cfc6ca). */
export type TerminalTabRecoveryLedger = {
  /** Remount timestamps inside the rolling window. Backstop, not the control. */
  attemptedAt: number[]
  /** Recovery epoch. A mounted pane captures it and stale requests are refused. */
  generation: number
  /** What the mounted pane observed for the attempt this ledger describes. */
  outcome: TerminalPaneRecoveryOutcome
  /** When that attempt was requested. Bounds how long 'pending' may block. */
  startedAt: number
  /** Refuse the same settled failure reason until a new trigger arrives. */
  reason: TerminalPaneRecoveryReason
  /** Capture tab.generation after remount; later authority/retry/activation bumps supersede this ledger without another writer. */
  tabGeneration: number
}

export type TerminalTab = {
  id: string
  ptyId: string | null
  worktreeId: string
  title: string
  /** Keep the original numbered label when agent OSC updates replace the live title. */
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
  /** Host-persisted view preference converges paired clients; older saved tabs default to terminal. */
  viewMode?: 'terminal' | 'chat'
  sortOrder: number
  createdAt: number
  /** Bumped on shutdown so TerminalPane remounts with a fresh PTY. */
  generation?: number
  /** Keep shell identity/icon stable across default-setting changes; older saved tabs may omit this. */
  shellOverride?: string
  /** Keeps an ephemeral host fallback out of the active project's runtime. */
  forceHostRuntime?: boolean
  /** An explorer cwd below root retains workspace tab/session ownership. */
  startupCwd?: string
  /** Show the launched agent’s icon before its first hook; live status later wins. Plain terminals/manually started agents omit this. */
  launchAgent?: TuiAgent
  /** Session-only agent.launch pane reservation, cleared on attachment/return to an ordinary terminal.
   * Retain main’s outcome until it quits or a different operationId reuses the pane; same-launch retries do not change it. Never persist. */
  agentLaunchPane?: { leafId: string; operationId?: string; outcome?: AgentLaunchPaneOutcome }
  /** Navigation-driven remounts must not bump workspace activity/sortEpoch and reorder the sidebar on click.
   * Transient handoff consumed by PTY lifecycle; split layouts count multiple pending spawns. Never persist. */
  pendingActivationSpawn?: boolean | number
  /** Saved bindings identify restored panes; host retirement must match that identity. Transient until PTY binding. */
  restoredFromSession?: true
  /** Never persist in-flight recovery: stale ledgers would refuse valid post-restart recovery. Sanitize like pendingActivationSpawn. */
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
  /** Stable leaf that owns the terminal tab's native chat surface. */
  chatLeafId?: string
  /** Live bindings support in-session remounts; transient PTYs cannot be reused after app restart. */
  ptyIdsByLeafId?: Record<string, string>
  /** Serialized terminal buffers per leaf for scrollback restoration on restart. */
  buffersByLeafId?: Record<string, string>
  /** Durable scrollback snapshot refs per leaf; raw bytes live outside session JSON. */
  scrollbackRefsByLeafId?: Record<string, string>
  titlesByLeafId?: Record<string, string>
  /** Each pane's last grid, so main starts its terminal at that size. Older builds drop it. */
  lastGridsByLeafId?: Record<string, TerminalGrid>
}

export type TerminalGrid = { cols: number; rows: number }
