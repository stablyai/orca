import type {
  ComputerActionMetadata,
  ComputerActionVerification,
  ComputerSnapshotResult
} from './computer-use-runtime-types'

export type ComputerBatchStopOn = 'error' | 'suspect' | 'unverified'

export type ComputerBatchStepResult = {
  step: number
  command: string
  ok: boolean
  elapsedMs: number
  path?: ComputerActionMetadata['path']
  delivery?: ComputerActionMetadata['delivery']
  verification?: ComputerActionVerification
  error?: { code: string; message: string }
}

export type ComputerBatchSummary = {
  total: number
  completed: number
  stopOn: ComputerBatchStopOn
  // 1-based step that stopped the batch; later steps did not run.
  stoppedAt?: number
  stopReason?: ComputerBatchStopOn
  elapsedMs: number
}

// The snapshot fields are one read of the window after the last step, diffed against the read before the batch.
export type ComputerBatchResult = Partial<ComputerSnapshotResult> & {
  batch: ComputerBatchSummary
  steps: ComputerBatchStepResult[]
  finalStateError?: { code: string; message: string }
}
