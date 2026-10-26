import type { WriteSettlement } from './pty-write-settlement'

export type RuntimeTerminalSend = {
  handle: string
  accepted: boolean
  bytesWritten: number
  /** Wait after this acknowledgment before a separate Enter; older hosts omit it. */
  submitDelayMs?: number
  refusedReason?: 'no-agent' | 'permission'
  prompt?: RuntimeTerminalPromptDelivery
  writeSettlement?: WriteSettlement
}

export type RuntimeTerminalPromptSubmission =
  | { requestId: string; status: 'pending' }
  | { requestId: string; status: 'submitted'; send: RuntimeTerminalSend }
  | {
      requestId: string
      status: 'failed'
      reason: 'permission' | 'no-agent' | 'not-writable' | 'submission-failed'
      inputWritten: boolean
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
}
