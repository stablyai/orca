import type { DirectSshAuthority } from '../../../shared/ssh-types'
import {
  createDirectSshPreparationCoordinator,
  type DirectSshPreparationCoordinator
} from './direct-ssh-reconnect-preparation'
import {
  combineDirectSshReconnectOutcome,
  createEmptyDirectSshRepoOutcomeCounts,
  createTerminalOnlyDirectSshReconnectOutcome
} from './direct-ssh-reconnect-coordinator-outcomes'
import {
  createDirectSshReconnectTargetState,
  type DirectSshReconnectTargetState
} from './direct-ssh-reconnect-coordinator-stabilization'
import { createDirectSshCoordinatorTelemetryReporter } from './direct-ssh-reconnect-coordinator-telemetry'
import type {
  DirectSshCorrectionReason,
  DirectSshPreparationInput,
  DirectSshPreparationOutcome,
  DirectSshPreparationReason,
  DirectSshReconnectCoordinator,
  DirectSshReconnectCoordinatorDeps,
  DirectSshReconnectOutcome,
  DirectSshReconnectTimer
} from './direct-ssh-reconnect-coordinator-types'
import {
  directSshAuthoritiesEqual,
  isDirectSshPreparationInputHostConsistent,
  normalizeDirectSshPreparationInput
} from './direct-ssh-reconnect-tokens'
export type * from './direct-ssh-reconnect-coordinator-types'
export {
  admitDirectSshSnapshotApplyToken,
  buildDirectSshSnapshotApplyToken
} from './direct-ssh-reconnect-tokens'

export const DIRECT_SSH_RELAY_STABILIZATION_MS = 5_000

export function createDirectSshReconnectCoordinator(
  deps: DirectSshReconnectCoordinatorDeps
): DirectSshReconnectCoordinator {
  const now = deps.now ?? Date.now
  const setTimer =
    deps.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer =
    deps.clearTimer ??
    ((timer: DirectSshReconnectTimer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const stabilizationMs = deps.stabilizationMs ?? DIRECT_SSH_RELAY_STABILIZATION_MS
  const targets = new Map<string, DirectSshReconnectTargetState>()
  let stopped = false

  const isCurrent = (authority: DirectSshAuthority): boolean => {
    const state = targets.get(authority.targetId)
    return (
      !stopped &&
      directSshAuthoritiesEqual(state?.authority, authority) &&
      deps.isCurrentConnectedAuthority(authority)
    )
  }

  const preparation: DirectSshPreparationCoordinator = createDirectSshPreparationCoordinator({
    scheduler: deps.scheduler,
    isCurrentAuthority: isCurrent,
    readLineage: deps.readHostScopedLineage,
    now
  })
  const telemetry = createDirectSshCoordinatorTelemetryReporter({
    onTelemetry: deps.onTelemetry,
    now
  })

  const replaceAuthority = (authority: DirectSshAuthority): boolean => {
    if (stopped) {
      return false
    }
    const previous = targets.get(authority.targetId)
    if (directSshAuthoritiesEqual(previous?.authority, authority)) {
      return false
    }
    if (previous) {
      if (previous.timer) {
        clearTimer(previous.timer)
      }
      preparation.invalidateAuthority(previous.authority)
      deps.scheduler.disposeProvider(previous.authority)
    }
    const installedAt = now()
    targets.set(
      authority.targetId,
      createDirectSshReconnectTargetState(authority, previous, installedAt, stabilizationMs)
    )
    return previous !== undefined
  }

  const captureInput = async (
    authority: DirectSshAuthority,
    reason: DirectSshPreparationReason
  ): Promise<DirectSshPreparationInput | null> => {
    const captured = await deps.capturePreparationInput(authority, reason)
    if (
      !captured ||
      !directSshAuthoritiesEqual(captured, authority) ||
      !isDirectSshPreparationInputHostConsistent(captured) ||
      !isCurrent(authority)
    ) {
      return null
    }
    return normalizeDirectSshPreparationInput({ ...captured, reason })
  }

  const startSync = (token: NonNullable<DirectSshPreparationOutcome['token']>): void => {
    try {
      void Promise.resolve(deps.syncRemoteWorkspaceAfterConnect(token)).catch(() => {})
    } catch {
      // Sync failure is reported by its owning boundary.
    }
  }

  const runPreparedReconnect = async (
    authority: DirectSshAuthority,
    staleBindingsCleared: number,
    retriedTerminals: number,
    damped: boolean,
    operationStartedAt = now(),
    terminalFinalizationDurationMs = 0,
    authorityRotationCount = 0
  ): Promise<DirectSshReconnectOutcome> => {
    const input = await captureInput(authority, 'reconnect')
    if (!input) {
      const outcome = createTerminalOnlyDirectSshReconnectOutcome(
        'stale',
        staleBindingsCleared,
        retriedTerminals
      )
      telemetry.reportWithoutInput('reconnect', 'reconnect', outcome, operationStartedAt, {
        staleBindingsCleared,
        retriedTerminals,
        terminalFinalizationDurationMs,
        catalogOutcome: 'stale',
        catalogDurationMs: Math.max(0, now() - operationStartedAt),
        authorityRotationCount,
        damped
      })
      return outcome
    }
    const acquired = preparation.acquire(input)
    const prepared = await acquired.promise
    let correctedTerminals = 0
    if (prepared.token && isCurrent(authority)) {
      correctedTerminals = deps.correctUnboundTerminalPanes(authority, 'preparation-complete')
      if (isCurrent(authority)) {
        startSync(prepared.token)
      }
    }
    const outcome = combineDirectSshReconnectOutcome(
      prepared,
      staleBindingsCleared,
      retriedTerminals,
      correctedTerminals
    )
    if (!acquired.joined) {
      telemetry.report('reconnect', input, prepared, operationStartedAt, {
        terminalFinalizationDurationMs,
        staleBindingsCleared,
        retriedTerminals,
        correctedTerminals,
        damped,
        authorityRotationCount
      })
    }
    return outcome
  }

  const runDelayedPreparation = async (authority: DirectSshAuthority): Promise<void> => {
    if (!isCurrent(authority)) {
      return
    }
    await runPreparedReconnect(authority, 0, 0, true, now(), 0, 1)
  }

  const scheduleLatestPreparation = (state: DirectSshReconnectTargetState): void => {
    if (state.timer || state.dampUntil === null) {
      return
    }
    const delayMs = Math.max(0, state.dampUntil - now())
    state.timer = setTimer(() => {
      state.timer = null
      state.dampUntil = null
      void runDelayedPreparation(state.authority)
    }, delayMs)
  }

  const requestReconnect = async (
    authority: DirectSshAuthority
  ): Promise<DirectSshReconnectOutcome> => {
    const startedAt = now()
    if (stopped || !deps.isCurrentConnectedAuthority(authority)) {
      const outcome = createTerminalOnlyDirectSshReconnectOutcome(stopped ? 'stopped' : 'stale')
      telemetry.reportWithoutInput('reconnect', 'reconnect', outcome, startedAt, {
        catalogOutcome: 'degraded'
      })
      return outcome
    }
    const rotated = replaceAuthority(authority)
    if (!isCurrent(authority)) {
      const outcome = createTerminalOnlyDirectSshReconnectOutcome('stale')
      telemetry.reportWithoutInput('reconnect', 'reconnect', outcome, startedAt, {
        authorityRotationCount: rotated ? 1 : 0
      })
      return outcome
    }
    const terminalStartedAt = now()
    const staleBindingsCleared = deps.invalidateStaleTerminalBindings(authority)
    const retriedTerminals = deps.retryTargetPanes(authority)
    const terminalFinalizationDurationMs = Math.max(0, now() - terminalStartedAt)
    const state = targets.get(authority.targetId)!
    if (state.dampUntil !== null && now() < state.dampUntil) {
      scheduleLatestPreparation(state)
      const outcome = createTerminalOnlyDirectSshReconnectOutcome(
        'stabilizing',
        staleBindingsCleared,
        retriedTerminals
      )
      telemetry.reportWithoutInput('reconnect', 'reconnect', outcome, startedAt, {
        staleBindingsCleared,
        retriedTerminals,
        terminalFinalizationDurationMs,
        catalogOutcome: 'degraded',
        authorityRotationCount: rotated ? 1 : 0,
        damped: true
      })
      return outcome
    }
    return runPreparedReconnect(
      authority,
      staleBindingsCleared,
      retriedTerminals,
      false,
      startedAt,
      terminalFinalizationDurationMs,
      rotated ? 1 : 0
    )
  }

  const prepareOnly = (
    rawInput: DirectSshPreparationInput
  ): Promise<DirectSshPreparationOutcome> => {
    const input = normalizeDirectSshPreparationInput(rawInput)
    if (stopped || !isCurrent(input) || !isDirectSshPreparationInputHostConsistent(input)) {
      const outcome: DirectSshPreparationOutcome = {
        status: stopped ? 'stopped' : 'stale',
        token: null,
        repoOutcomes: createEmptyDirectSshRepoOutcomeCounts(),
        lineageOutcome: 'not-started',
        metrics: createTerminalOnlyDirectSshReconnectOutcome('stale').metrics
      }
      telemetry.report('prepare-only', input, outcome, now())
      return Promise.resolve(outcome)
    }
    const startedAt = now()
    const acquired = preparation.acquire(input)
    if (!acquired.joined) {
      void acquired.promise.then((outcome) => {
        telemetry.report('prepare-only', input, outcome, startedAt)
      })
    }
    return acquired.promise
  }

  const finalizeHydratedTerminals = (authority: DirectSshAuthority): number =>
    isCurrent(authority) ? deps.finalizeHydratedTerminalPanes(authority) : 0

  const correctUnboundTerminals = (
    authority: DirectSshAuthority,
    reason: DirectSshCorrectionReason
  ): number => (isCurrent(authority) ? deps.correctUnboundTerminalPanes(authority, reason) : 0)

  const invalidate = (targetId: string): void => {
    const state = targets.get(targetId)
    if (state?.timer) {
      clearTimer(state.timer)
    }
    preparation.invalidateTarget(targetId)
    deps.scheduler.invalidateTarget(targetId)
    targets.delete(targetId)
  }

  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    for (const state of targets.values()) {
      if (state.timer) {
        clearTimer(state.timer)
      }
    }
    preparation.stop()
    deps.scheduler.stop()
    targets.clear()
  }

  return {
    requestReconnect,
    prepareOnly,
    finalizeHydratedTerminals,
    correctUnboundTerminals,
    replaceAuthority,
    invalidate,
    stop
  }
}
