export type AgentSessionDeathEvidence = {
  kind: 'exit-observed' | 'kill-delivered' | 'pid-absent' | 'identity-mismatch'
  detail: string
  observedAt: number
  /** Fence of the owner (or reservation) this death is about; a fence names exactly one. Absent on
   *  evidence older builds wrote, which then speaks for no turn. */
  ownerFence?: number
  /** Last liveness proof by the transport holder; absent for surface release, failed start or older evidence. */
  lastProvenAliveAt?: number
  /** Quit/update/crash when the provider died with its runtime; absent for independent/unknown death. Keep open strings and read with isAgentSessionOrcaStopCause. */
  runtimeEnd?: string
}
