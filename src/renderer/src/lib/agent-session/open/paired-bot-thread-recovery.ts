import {
  structuredSessionOpenFailure,
  type StructuredSessionOpenDeps,
  type StructuredSessionOpenTarget
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { createRuntimeRpcAbortError } from '@/runtime/rpc/calls/abortable-runtime-environment-call'
import {
  createSharedRuntimeRpcAdmission,
  type SharedRuntimeRpcAdmission
} from '@/runtime/rpc/calls/shared-runtime-rpc-admission'
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
type Pending<T> = Scope & {
  targetKey: string
  request: Promise<T>
  admission: SharedRuntimeRpcAdmission
}
type RevealResult = {
  target: { worktreeId: string; sessionId: string }
  outcome: StructuredSessionRevealOutcome
}

const pendingLocations = new Map<string, Pending<LocateResult>>()
const pendingReveals = new Map<string, Pending<RevealResult>>()

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
  let completedReveal: RevealResult | undefined
  const recordReveal = (result: RevealResult): void => {
    completedReveal = result
    if (revealedChat(result.outcome)) {
      minimumReceivedFrame = nextReceivedSessionTabsFrame()
    }
  }
  const find = <T>(
    pending: Map<string, Pending<T>>,
    targetKey?: string
  ): Pending<T> | undefined => {
    const entry = pending.get(key)
    return entry &&
      entry.registration === registration &&
      entry.generation === generation &&
      (targetKey === undefined || entry.targetKey === targetKey)
      ? entry
      : undefined
  }
  const observe = <T>({ request, admission }: Pending<T>): Promise<T> =>
    sharedPromiseSettlementWaiters(request).wait({
      signal,
      timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
      createAbortError: () => abortSignalReason(signal),
      createTimeoutError: () => new Error('structured_session_restore_timeout'),
      onAbandon: admission.onAbandon
    })
  const wait = <T>(
    pending: Map<string, Pending<T>>,
    targetKey: string,
    load: (options: { beforeSend: () => void; admissionSignal: AbortSignal }) => Promise<T>
  ): Promise<T> => {
    const existing = find(pending, targetKey)
    if (existing) {
      return observe(existing)
    }
    const forget = (): void => {
      if (pending.get(key)?.request === request) {
        pending.delete(key)
      }
    }
    const admission = createSharedRuntimeRpcAdmission(
      () => sharedPromiseSettlementWaiters(request).waiterCount > 0,
      forget
    )
    const checkConnection = (): void => {
      if (
        getRuntimeEnvironmentRegistration(environmentId) !== registration ||
        getRuntimeEnvironmentConnectionGeneration(environmentId) !== generation
      ) {
        throw createRuntimeRpcAbortError()
      }
    }
    const request: Promise<T> = Promise.resolve()
      .then(() => {
        checkConnection()
        admission.check()
        return load({
          beforeSend: () => {
            checkConnection()
            admission.beforeSend()
          },
          admissionSignal: admission.signal
        })
      })
      .finally(forget)
    const entry = { registration, generation, targetKey, request, admission }
    pending.set(key, entry)
    return observe(entry)
  }
  return {
    resumePending: async (): Promise<boolean> => {
      if (find(pendingLocations)) {
        return true
      }
      const pending = find(pendingReveals)
      if (!pending) {
        return false
      }
      recordReveal(await observe(pending))
      return true
    },
    minimumInventoryFrame: (): number | undefined => minimumReceivedFrame,
    locate: async (address: string, messageIds: readonly string[]): Promise<LocateResult> => {
      if (completedReveal) {
        const chat = revealedChat(completedReveal.outcome) ?? completedReveal.target
        return { location: { kind: 'chat', ...chat } }
      }
      try {
        return await wait(pendingLocations, JSON.stringify([address, messageIds]), (options) =>
          callStructuredSessionParty(
            owner,
            'orchestration.partyLocation',
            address,
            messageIds,
            options
          )
        )
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    },
    reveal: async ({
      worktreeId,
      sessionId
    }: {
      worktreeId: string
      sessionId: string
    }): Promise<StructuredSessionRevealOutcome> => {
      const target = { worktreeId, sessionId }
      if (completedReveal) {
        const chat = revealedChat(completedReveal.outcome) ?? completedReveal.target
        if (chat.sessionId === target.sessionId && chat.worktreeId === target.worktreeId) {
          return completedReveal.outcome
        }
      }
      try {
        const result = await wait(
          pendingReveals,
          `${target.worktreeId}\0${target.sessionId}`,
          async (options) => ({
            target,
            outcome: await revealStructuredSession({ ...target, target: owner, ...options })
          })
        )
        recordReveal(result)
        return result.outcome
      } catch (error) {
        return structuredSessionOpenFailure(error)
      }
    }
  }
}

function revealedChat(outcome: StructuredSessionRevealOutcome): StructuredSessionOpenTarget | null {
  return typeof outcome === 'object' && 'sessionId' in outcome ? outcome : null
}
