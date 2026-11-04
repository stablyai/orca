import { createMobileE2EEOutboundMemoryBudget } from '../mobile-e2ee-outbound-memory-budget'

const budget = createMobileE2EEOutboundMemoryBudget({ maxQueuedBytes: 64 * 1024 * 1024 })
export const remoteRuntimeOutboundAdmission = {
  registerBufferedAmount: budget.registerBufferedAmount,
  claimQueuedBytes: (bytes: number) => budget.claimQueuedBytes(2 * bytes)
}
export const remoteRuntimeOutboundEvidence = budget.evidence
