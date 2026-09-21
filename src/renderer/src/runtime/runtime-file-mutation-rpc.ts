import type { RuntimeStatus } from '../../../shared/runtime-types'
import { assertFileMutationOwnershipCapability } from '../../../shared/file-mutation-ownership'
import { callRuntimeRpc } from './runtime-rpc-client'
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

export async function assertRuntimeFileMutationCapability(
  target: RuntimeFileMutationTarget,
  expectedEnvironmentPairingRevision: number | undefined
): Promise<string> {
  const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision
  })
  assertFileMutationOwnershipCapability(status)
  return status.runtimeId
}

export async function callRuntimeFileMutation<TResult>(
  target: RuntimeFileMutationTarget,
  method: string,
  params: unknown,
  timeoutMs: number,
  expectedEnvironmentPairingRevision?: number
): Promise<TResult> {
  const requestRevision = captureRuntimeEnvironmentRequestRevision(
    target.environmentId,
    expectedEnvironmentPairingRevision
  )
  await assertRuntimeFileMutationCapability(target, requestRevision)
  return callRuntimeRpc<TResult>(target, method, params, {
    timeoutMs,
    expectedEnvironmentPairingRevision: requestRevision
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
