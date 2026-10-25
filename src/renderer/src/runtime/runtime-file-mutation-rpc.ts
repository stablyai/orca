import type { RuntimeStatus } from '../../../shared/runtime-types'
import { RUNTIME_CONNECTION_CHANGED_MESSAGE } from '../web/web-runtime-request-registry'
import { assertFileMutationOwnershipCapability } from '../../../shared/file-mutation-ownership'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from './runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status'

type RuntimeFileMutationTarget = { kind: 'environment'; environmentId: string }
export type RuntimeFileImportSession = {
  target: RuntimeFileMutationTarget
  expectedEnvironmentPairingRevision: number | undefined
  expectedEnvironmentConnectionGeneration: number
  expectedEnvironmentRuntimeId: string
  assertCurrent: () => void
}

async function getRuntimeFileMutationStatus(
  target: RuntimeFileMutationTarget,
  expectedEnvironmentPairingRevision: number | undefined
): Promise<RuntimeStatus> {
  const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision
  })
  assertFileMutationOwnershipCapability(status)
  return status
}

export async function assertRuntimeFileMutationCapability(
  target: RuntimeFileMutationTarget,
  expectedEnvironmentPairingRevision: number | undefined
): Promise<string> {
  return (await getRuntimeFileMutationStatus(target, expectedEnvironmentPairingRevision)).runtimeId
}

/** Thrown before sending, so nothing reached either runtime and a re-probed retry is safe. */
export class RuntimeConnectionChangedError extends Error {
  constructor() {
    super(RUNTIME_CONNECTION_CHANGED_MESSAGE)
  }
}

/**
 * The paired web client's transport refuses with the same wording before it sends; the desktop
 * transport answers `runtime_environment_changed` only before sending, when its socket reached
 * another runtime than the one probed.
 */
export function isRuntimeConnectionChangedError(error: unknown): boolean {
  return (
    error instanceof RuntimeConnectionChangedError ||
    (error instanceof RuntimeRpcCallError && error.code === 'runtime_environment_changed') ||
    (error instanceof Error && error.message === RUNTIME_CONNECTION_CHANGED_MESSAGE)
  )
}

export type RuntimeFileMutationPlan<TResult> =
  | { method?: string; params: unknown }
  | { result: TResult }

/**
 * `plan` sees the ownership probe's capabilities, so a capability-gated field costs no extra status
 * call. The send is pinned to that runtime and connection: a reconnect to an older one in between
 * would silently strip whatever the plan relied on.
 */
export async function callRuntimeFileMutationWithCapabilities<TResult>(
  target: RuntimeFileMutationTarget,
  method: string,
  plan: (capabilities: readonly string[]) => Promise<RuntimeFileMutationPlan<TResult>>,
  timeoutMs: number,
  expectedEnvironmentPairingRevision?: number,
  beforeSend?: () => void
): Promise<TResult> {
  const requestRevision = captureRuntimeEnvironmentRequestRevision(
    target.environmentId,
    expectedEnvironmentPairingRevision
  )
  const connectionGeneration = getRuntimeEnvironmentConnectionGeneration(target.environmentId)
  const status = await getRuntimeFileMutationStatus(target, requestRevision)
  const planned = await plan(status.capabilities ?? [])
  if ('result' in planned) {
    return planned.result
  }
  return callRuntimeRpc<TResult>(target, planned.method ?? method, planned.params, {
    timeoutMs,
    expectedEnvironmentPairingRevision: requestRevision,
    expectedEnvironmentRuntimeId: status.runtimeId,
    beforeSend: () => {
      if (
        getRuntimeEnvironmentConnectionGeneration(target.environmentId) !== connectionGeneration
      ) {
        throw new RuntimeConnectionChangedError()
      }
      beforeSend?.()
    }
  })
}

export async function callRuntimeFileMutation<TResult>(
  target: RuntimeFileMutationTarget,
  method: string,
  params: unknown,
  timeoutMs: number,
  expectedEnvironmentPairingRevision?: number,
  beforeSend?: () => void
): Promise<TResult> {
  const requestRevision = captureRuntimeEnvironmentRequestRevision(
    target.environmentId,
    expectedEnvironmentPairingRevision
  )
  await getRuntimeFileMutationStatus(target, requestRevision)
  return callRuntimeRpc<TResult>(target, method, params, {
    timeoutMs,
    expectedEnvironmentPairingRevision: requestRevision,
    beforeSend
  })
}

export function createRuntimeImportSessionGuard(
  environmentId: string,
  expectedEnvironmentPairingRevision: number | undefined,
  expectedEnvironmentConnectionGeneration: number,
  assertCallerCurrent?: () => void
): () => void {
  return () => {
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
      throw new Error('Runtime pairing changed; retry the import.')
    }
    // Why: a replacement runtime keeps the pairing but invalidates its predecessor's capability proof.
    if (
      getRuntimeEnvironmentConnectionGeneration(environmentId) !==
      expectedEnvironmentConnectionGeneration
    ) {
      throw new Error('Runtime connection changed; retry the import.')
    }
    assertCallerCurrent?.()
  }
}

export function callRuntimeFileImportMutation<TResult>(
  session: RuntimeFileImportSession,
  method: string,
  params: unknown,
  timeoutMs: number
): Promise<TResult> {
  session.assertCurrent()
  return callRuntimeRpc<TResult>(session.target, method, params, {
    timeoutMs,
    expectedEnvironmentPairingRevision: session.expectedEnvironmentPairingRevision,
    expectedEnvironmentRuntimeId: session.expectedEnvironmentRuntimeId
  })
}
