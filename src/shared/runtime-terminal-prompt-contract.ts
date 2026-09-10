export type RuntimeTerminalPromptStage = 'input_accepted' | 'turn_started'

export type RuntimeTerminalPromptDelivery = {
  requestId: string
  stages: RuntimeTerminalPromptStage[]
  provider: 'claude' | 'codex' | 'unsupported' | 'old-host'
  observation: 'supported' | 'unsupported' | 'incarnation_replaced' | 'permission'
  processIncarnation: string
  generation: number
  baselineWorkingSequence: number
  /** Hook turn-start timestamp before this prompt was accepted. */
  baselineExplicitWorkingStartedAt?: number | null
  /** Permission observations seen before this prompt was accepted. */
  baselinePermissionSequence?: number
}
