import type { WriteSettlement } from '../pty/lifecycle/pty-write-settlement'
import type { RuntimeTerminalWaitBlockedReason } from './runtime-terminal-contracts'

export type RuntimeTerminalSend = {
  handle: string
  accepted: boolean
  bytesWritten: number
  refusedReason?: 'no-agent' | 'permission' | 'approval-unseen'
  prompt?: RuntimeTerminalPromptDelivery
  writeSettlement?: WriteSettlement
}

export type RuntimeTerminalPromptStage = 'input_accepted' | 'turn_started'

export type RuntimeTerminalPromptDelivery = {
  requestId: string
  stages: RuntimeTerminalPromptStage[]
  provider: 'antigravity' | 'claude' | 'codex' | 'unsupported' | 'old-host'
  observation: 'supported' | 'unsupported' | 'incarnation_replaced' | 'permission'
  processIncarnation: string
  generation: number
  baselineWorkingSequence: number
  /** Hook turn-start timestamp before this prompt was accepted. */
  baselineExplicitWorkingStartedAt?: number | null
  /** Permission observations seen before this prompt was accepted. */
  baselinePermissionSequence?: number
  /** When the paste and its Enter were written (epoch ms), for a start Orca never saw begin. */
  submit?: RuntimeTerminalPromptSubmit
}

export type RuntimeTerminalPromptSubmit = {
  pastedAt: number
  /** What ended the wait before Enter: screen quiet, the exact paste in the composer, or the cap. */
  renderWait?: 'quiet' | 'draft' | 'cap'
} & (
  | { enteredAt: number }
  /** The screen showed this dialog after the paste, so Orca did not press Enter into it. */
  | { withheldFor: RuntimeTerminalWaitBlockedReason }
)
