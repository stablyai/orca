import type { TerminalExitCause } from './terminal-exit-cause'
import type { RuntimeTerminalState } from './runtime-terminal-contracts'

export type RuntimeTerminalWaitCondition = 'exit' | 'tui-idle'

export type RuntimeTerminalWaitBlockedReason =
  | 'codex-update-prompt'
  | 'codex-trust-workspace'
  | 'codex-cwd-prompt'
  | 'codex-model-migration-prompt'
  | 'codex-hooks-review-prompt'
  | 'codex-interactive-prompt'
  | 'agent-update-prompt'
  | 'agent-trust-workspace'
  | 'agent-cwd-prompt'
  | 'agent-hooks-review-prompt'
  | 'agent-interactive-prompt'
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
