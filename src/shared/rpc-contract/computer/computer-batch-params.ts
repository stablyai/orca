import { z } from 'zod'
import { ComputerObserveTargetBase, validateComputerTarget } from './computer-schemas-params'

export const COMPUTER_BATCH_MAX_STEPS = 50
export const COMPUTER_BATCH_MAX_WAIT_MS = 10_000

export const COMPUTER_BATCH_STOP_ON = ['error', 'suspect', 'unverified'] as const

// Steps stay loose here: the runner checks each one against its command's own schema before any step runs.
export const ComputerBatch = ComputerObserveTargetBase.extend({
  steps: z.array(z.unknown()).min(1, 'Missing steps').max(COMPUTER_BATCH_MAX_STEPS),
  stopOn: z.enum(COMPUTER_BATCH_STOP_ON).optional()
}).superRefine(validateComputerTarget)

export type ComputerBatchParams = z.infer<typeof ComputerBatch>
