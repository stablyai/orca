import {
  structuredSessionOpenFailure,
  type StructuredSessionOpenDeps,
  type StructuredSessionOpenTarget
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { createRuntimeRpcAbortError } from '@/runtime/rpc/calls/abortable-runtime-environment-call'
import { getRuntimeEnvironmentRegistration } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { abortSignalReason } from '../../../../../shared/concurrency/abort-signal-reason'
import { sharedPromiseSettlementWaiters } from '../../../../../shared/concurrency/promise-settlement-waiters'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { nextReceivedSessionTabsFrame } from '@/runtime/web-session-tabs-sync/state'
import {
  callStructuredSessionParty,
  revealStructuredSession,
  STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
  type StructuredSessionRevealOutcome
} from './structured-session-restore'

type Owner = Extract<RuntimeClientTarget, { kind: 'environment' }>
type Scope = {
  registration: ReturnType<typeof getRuntimeEnvironmentRegistration>
  generation: number
}
type LocateResult = Awaited<ReturnType<StructuredSessionOpenDeps['locate']>>
type Pending<T> = Scope & { targetKey: string; request: Promise<T> }

const pendingLocations = new Map<string, Pending<LocateResult>>()
const pendingReveals = new Map<string, Pending<StructuredSessionRevealOutcome>>()

export function pairedBotThreadRecovery(
  owner: Owner,
  workspaceId: string,
  sessionId: string,
  signal: AbortSignal
) {
  const { environmentId } = owner
  const key = `${environmentId}\0${workspaceId}\0${sessionId}`
  const registration = getRuntimeEnvironmentRegistration(environmentId)
  const generation = getRuntimeEnvironmentConnectionGeneration(environmentId)
  let minimumReceivedFrame: number | undefined
  let confirmedReveal: StructuredSessionOpenTarget | undefined
  const recordReveal = (result: StructuredSessionRevealOutcome): boolean => {
    if (typeof result === 'object' && 'sessionId' in result) {
      confirmedReveal = result
      minimumReceivedFrame = nextReceivedSessionTabsFrame()
      return true
    }
    return false
  }
  const find = <T>(
    pending: Map<string, Pending<T>>,
    targetKey?: string
  ): Promise<T> | undefined => {
    const entry = pending.get(key)
    return entry &&
      entry.registration === registration &&
      entry.generation === generation &&
      (targetKey === undefined || entry.targetKey === targetKey)
      ? entry.request
      : undefined
  }
  const observe = <T>(request: Promise<T>): Promise<T> =>
    sharedPromiseSettlementWaiters(request).wait({
      signal,
      timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
      createAbortError: () => abortSignalReason(signal),
      createTimeoutError: () => new Error('structured_session_restore_timeout')
    })
  const wait = <T>(
    pending: Map<string, Pending<T>>,
    targetKey: string,
    load: (beforeSend: () => void) => Promise<T>
  ): Promise<T> => {
    const existing = find(pending, targetKey)
    if (existing) {
      return observe(existing)
    }
    const request: Promise<T> = Promise.resolve()
      .then(() => {
        const beforeSend = (): void => {
          if (
            !sharedPromiseSettlementWaiters(request).waiterCount ||
            getRuntimeEnvironmentRegistration(environmentId) !== registration ||
            getRuntimeEnvironmentConnectionGeneration(environmentId) !== generation
          ) {
            throw createRuntimeRpcAbortError()
          }
        }
        beforeSend()
        return load(beforeSend)
      })
      .finally(() => {
        if (pending.get(key)?.request === request) {
          pending.delete(key)
        }
      })
    pending.set(key, { registration, generation, targetKey, request })
    return observe(request)
  }
  return {
    resumePending: async (): Promise<boolean> => {
      if (find(pendingLocations)) {
        return true
      }
      const pending = find(pendingReveals)
      return pending ? recordReveal(await observe(pending)) : false
    },
    minimumInventoryFrame: (): number | undefined => minimumReceivedFrame,
    locate: async (address: string, messageIds: readonly string[]): Promise<LocateResult> => {
      if (confirmedReveal) {
        return { location: { kind: 'chat', ...confirmedReveal } }
      }
      try {
        return await wait(pendingLocations, JSON.stringify([address, messageIds]), (beforeSend) =>
          callStructuredSessionParty(owner, 'orchestration.partyLocation', address, messageIds, {
            beforeSend
          })
        )
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    },
    reveal: async (target: {
      worktreeId: string
      sessionId: string
    }): Promise<StructuredSessionRevealOutcome> => {
      if (
        confirmedReveal?.sessionId === target.sessionId &&
        confirmedReveal.worktreeId === target.worktreeId
      ) {
        return confirmedReveal
      }
      try {
        const outcome = await wait(
          pendingReveals,
          `${target.worktreeId}\0${target.sessionId}`,
          (beforeSend) => revealStructuredSession({ ...target, target: owner, beforeSend })
        )
        recordReveal(outcome)
        return outcome
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    }
  }
}
