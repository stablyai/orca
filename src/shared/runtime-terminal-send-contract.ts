import type { WriteSettlement } from './terminal/pty/lifecycle/pty-write-settlement'

export type RuntimeTerminalSend = {
  handle: string
  accepted: boolean
  bytesWritten: number
  /** `input-changed`: the terminal took other input after the text `expectInputGeneration` names. */
  refusedReason?: 'no-agent' | 'permission' | 'input-changed'
  prompt?: RuntimeTerminalPromptDelivery
  writeSettlement?: WriteSettlement
  /** How long the client must wait before sending this text's Enter. Older hosts omit it. */
  submitDelayMs?: number
  /** Names this text as the terminal's last input; its Enter passes it back as
   *  `expectInputGeneration`. Older hosts omit it. */
  /** On an input-changed refusal, names the input now waiting instead. */
  inputGeneration?: number
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
