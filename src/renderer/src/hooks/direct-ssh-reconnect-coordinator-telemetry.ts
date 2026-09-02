import type {
  DirectSshCoordinatorTelemetry,
  DirectSshPreparationInput,
  DirectSshPreparationOutcome,
  DirectSshPreparationReason,
  DirectSshReconnectOutcome
} from './direct-ssh-reconnect-coordinator-types'
import { createTerminalOnlyDirectSshReconnectOutcome } from './direct-ssh-reconnect-coordinator-outcomes'

type TelemetryOutcome = DirectSshPreparationOutcome | DirectSshReconnectOutcome

type TelemetryOptions = {
  terminalFinalizationDurationMs?: number
  staleBindingsCleared?: number
  retriedTerminals?: number
  correctedTerminals?: number
  damped?: boolean
  authorityRotationCount?: number
  catalogOutcome?: DirectSshCoordinatorTelemetry['catalogOutcome']
  catalogDurationMs?: number
}

type DirectSshCoordinatorTelemetryReporter = {
  report: (
    mode: DirectSshCoordinatorTelemetry['mode'],
    input: DirectSshPreparationInput,
    outcome: TelemetryOutcome,
    startedAt: number,
    options?: TelemetryOptions
  ) => void
  reportWithoutInput: (
    mode: DirectSshCoordinatorTelemetry['mode'],
    reason: DirectSshPreparationReason,
    outcome: TelemetryOutcome,
    startedAt: number,
    options?: TelemetryOptions
  ) => void
}

export function createDirectSshCoordinatorTelemetryReporter(args: {
  onTelemetry?: (event: DirectSshCoordinatorTelemetry) => void
  now: () => number
}): DirectSshCoordinatorTelemetryReporter {
  const emit = (event: DirectSshCoordinatorTelemetry): void => {
    try {
      args.onTelemetry?.(event)
    } catch {
      // Recovery cannot depend on diagnostics.
    }
  }

  const report = (
    mode: DirectSshCoordinatorTelemetry['mode'],
    input: DirectSshPreparationInput,
    outcome: TelemetryOutcome,
    startedAt: number,
    options: TelemetryOptions = {}
  ): void => {
    const inputMetrics = input.telemetry
    const outcomeMetrics =
      outcome.metrics ?? createTerminalOnlyDirectSshReconnectOutcome('stale').metrics!
    emit({
      mode,
      reason: input.reason,
      outcome: outcome.status,
      durationMs: Math.max(0, args.now() - startedAt),
      staleBindingsCleared: options.staleBindingsCleared ?? 0,
      retriedTerminals: options.retriedTerminals ?? 0,
      correctedTerminals: options.correctedTerminals ?? 0,
      terminalFinalizationDurationMs: options.terminalFinalizationDurationMs ?? 0,
      catalogOutcome: options.catalogOutcome ?? inputMetrics?.catalogOutcome ?? 'complete',
      catalogDurationMs: options.catalogDurationMs ?? inputMetrics?.catalogDurationMs ?? 0,
      gitWorktreeCount: inputMetrics?.gitWorktreeCount ?? 0,
      folderWorkspaceCount: inputMetrics?.folderWorkspaceCount ?? 0,
      ambiguousOwnerCount: inputMetrics?.ambiguousOwnerCount ?? 0,
      contradictoryOwnerCount: inputMetrics?.contradictoryOwnerCount ?? 0,
      repoOutcomes: { ...outcome.repoOutcomes },
      lineageOutcome: outcome.lineageOutcome,
      queueWaitDurationsMs: [...outcomeMetrics.queueWaitDurationsMs],
      providerExecutionDurationsMs: [...outcomeMetrics.providerExecutionDurationsMs],
      timeoutRetryCount: outcomeMetrics.timeoutRetryCount,
      locallySettledWaiterCount: outcomeMetrics.locallySettledWaiterCount,
      cancelDebtCount: outcomeMetrics.cancelDebtCount,
      replacementAdmissionDelayedCount: outcomeMetrics.replacementAdmissionDelayedCount,
      overlappingJoinCount: outcomeMetrics.schedulerOverlappingJoinCount,
      peakLocallyUnsettled: outcomeMetrics.peakLocallyUnsettled,
      estimatedLateWorkAllowanceCount: outcomeMetrics.estimatedLateWorkAllowanceCount,
      authorityRotationCount: options.authorityRotationCount ?? 0,
      damped: options.damped ?? false
    })
  }

  const reportWithoutInput: DirectSshCoordinatorTelemetryReporter['reportWithoutInput'] = (
    mode,
    reason,
    outcome,
    startedAt,
    options = {}
  ) => {
    report(
      mode,
      {
        targetId: '',
        providerEpoch: '' as DirectSshPreparationInput['providerEpoch'],
        connectionGeneration: 0,
        catalogRevision: 0,
        repoRefs: [],
        authorityRequirement: 'required',
        reason
      },
      outcome,
      startedAt,
      options
    )
  }

  return { report, reportWithoutInput }
}
