export const ORCHESTRATION_SENDER_CAPABILITY_ENV = 'ORCA_ORCHESTRATION_SENDER_CAPABILITY'

export type AuthenticatedOrchestrationSender = {
  canonicalHandle: string
  canonicalPaneKey: string
}

export type SshSenderBindingShutdownReceipt = {
  senderBindingGeneration: string
  senderBindingState: 'absent' | 'exited'
}
