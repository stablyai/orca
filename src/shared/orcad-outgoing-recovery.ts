import type { PtyOwnershipTransferSurfaceBinding } from './pty-ownership-transfer-surface-binding'

export type OrcadOutgoingPreparationRequest = {
  selector: string
  ptyId: string
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
}

export type OrcadOutgoingRecoveryCandidate = {
  stage?: 'preparation' | 'capture'
  bridgeId: string
  terminalId: string
  incarnationId: string
  destinationEnvironmentId: string
  destinationRuntimeId: string
  sourceSshTargetId: string
  sourceSshTargetGeneration: number
}

export type OrcadOutgoingRecoveryResult = {
  bridgeId: string
  outcome: 'published'
}
