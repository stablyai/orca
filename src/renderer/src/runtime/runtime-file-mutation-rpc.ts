import type { RuntimeStatus } from '../../../shared/runtime-types'
import { assertFileMutationOwnershipCapability } from '../../../shared/file-mutation-ownership'
import { callRuntimeRpc } from './runtime-rpc-client'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision
} from './runtime-environment-revision'

type RuntimeFileMutationTarget = { kind: 'environment'; environmentId: string }

export async function assertRuntimeFileMutationCapability(
  target: RuntimeFileMutationTarget,
  expectedEnvironmentPairingRevision: number | undefined
): Promise<void> {
  const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
    timeoutMs: 15_000,
    expectedEnvironmentPairingRevision
  })
  assertFileMutationOwnershipCapability(status)
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
  assertCallerCurrent?: () => void
): () => void {
  return () => {
    if (getRuntimeEnvironmentRevision(environmentId) !== expectedEnvironmentPairingRevision) {
      throw new Error('Runtime pairing changed; retry the import.')
    }
    assertCallerCurrent?.()
  }
}
