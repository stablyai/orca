import type { ExecutionHostId } from './execution-host'
import type { TerminalExitCause } from './terminal-exit-cause'
import type { RuntimeTerminalState } from './runtime-terminal-contracts'

export type RuntimeTerminalSplit = {
  handle: string
  tabId: string
  paneRuntimeId: number
  // Why: paired callers need the host-created leaf identity to focus the exact pane.
  leafId?: string
}

export type RuntimeTerminalResolvePane = {
  handle: string
  /** Host-owned PTY incarnation used to fence remote identity observations. */
  incarnationId?: string | null
  tabId: string
  leafId: string
  ptyId: string | null
  connected?: boolean
  worktreeId?: string
  executionHostId?: ExecutionHostId
  hostPlatform?: NodeJS.Platform
}

export type RuntimeTerminalFocus = {
  handle: string
  tabId: string
  worktreeId: string
  navigated?: boolean
}

export type RuntimeTerminalClose = {
  handle: string
  tabId: string
  closeMode?: 'tab'
  ptyKilled: boolean
  ptyStopVerdict?: 'live' | 'unverifiable'
  ptyStopReason?: string
}

export type RuntimeTerminalWaitCondition = 'exit' | 'tui-idle'

export type RuntimeTerminalWaitBlockedReason =
  | 'codex-update-prompt'
  | 'codex-trust-workspace'
  | 'codex-cwd-prompt'
  | 'codex-model-migration-prompt'
  | 'codex-hooks-review-prompt'
  | 'codex-interactive-prompt'
  | 'agent-approval-prompt'

export type RuntimeTerminalWait = {
  handle: string
  condition: RuntimeTerminalWaitCondition
  satisfied: boolean
  status: RuntimeTerminalState
  exitCode: number | null
  exitCause?: TerminalExitCause
  blockedReason?: RuntimeTerminalWaitBlockedReason
}

export type RuntimeTerminalCreate = {
  handle: string
  /** Host-owned PTY incarnation used to fence remote identity observations. */
  incarnationId?: string | null
  tabId?: string
  paneKey?: string | null
  ptyId?: string | null
  worktreeId: string
  title: string | null
  tabTitle?: string | null
  executionHostId?: ExecutionHostId
  hostPlatform?: NodeJS.Platform
  surface?: 'background' | 'visible'
  warning?: string
  agentSessionDisposition?: 'created' | 'adopted'
  isReattach?: true
  /** Spawn process identity for host-internal ownership proof. */
  processId?: number
}
