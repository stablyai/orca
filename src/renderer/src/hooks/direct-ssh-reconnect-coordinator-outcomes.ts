import type {
  DirectSshPreparationMetrics,
  DirectSshPreparationOutcome,
  DirectSshReconnectOutcome,
  DirectSshRepoOutcomeCounts
} from './direct-ssh-reconnect-coordinator-types'

export function createEmptyDirectSshRepoOutcomeCounts(): DirectSshRepoOutcomeCounts {
  return {
    complete: 0,
    'non-authoritative': 0,
    'timed-out': 0,
    'cancel-budget-exhausted': 0,
    canceled: 0,
    stale: 0,
    rejected: 0
  }
}

export function createEmptyDirectSshPreparationMetrics(): DirectSshPreparationMetrics {
  return {
    queueWaitDurationsMs: [],
    providerExecutionDurationsMs: [],
    timeoutRetryCount: 0,
    locallySettledWaiterCount: 0,
    cancelDebtCount: 0,
    replacementAdmissionDelayedCount: 0,
    schedulerOverlappingJoinCount: 0,
    peakLocallyUnsettled: 0,
    estimatedLateWorkAllowanceCount: 0,
    lineageDurationMs: 0
  }
}

export function combineDirectSshReconnectOutcome(
  prepared: DirectSshPreparationOutcome,
  staleBindingsCleared: number,
  retriedTerminals: number,
  correctedTerminals: number
): DirectSshReconnectOutcome {
  return {
    ...prepared,
    staleBindingsCleared,
    retriedTerminals,
    correctedTerminals,
    stabilizing: false
  }
}

export function createTerminalOnlyDirectSshReconnectOutcome(
  status: DirectSshReconnectOutcome['status'],
  staleBindingsCleared = 0,
  retriedTerminals = 0
): DirectSshReconnectOutcome {
  return {
    status,
    token: null,
    repoOutcomes: createEmptyDirectSshRepoOutcomeCounts(),
    lineageOutcome: 'not-started',
    metrics: createEmptyDirectSshPreparationMetrics(),
    staleBindingsCleared,
    retriedTerminals,
    correctedTerminals: 0,
    stabilizing: status === 'stabilizing'
  }
}
