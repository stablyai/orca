import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'

export type LiveRuntimeEnvironmentAuthority = Readonly<{
  runtimeId: string
  expectedEnvironmentPairingRevision: number | undefined
  capabilities: readonly RuntimeCapability[]
}>

export async function probeLiveRuntimeEnvironmentCapabilities(args: {
  environmentId: string
  requiredCapabilities: readonly RuntimeCapability[]
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
}): Promise<{ supported: boolean; authority: LiveRuntimeEnvironmentAuthority }> {
  const environmentId = args.environmentId.trim()
  const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
    environmentId,
    args.expectedEnvironmentPairingRevision
  )
  const response = await callRuntimeEnvironmentWithRevision({
    environmentId,
    method: 'status.get',
    params: undefined,
    timeoutMs: args.timeoutMs,
    expectedEnvironmentPairingRevision
  })
  const status = unwrapRuntimeRpcResult<RuntimeStatus>(
    response as RuntimeRpcResponse<RuntimeStatus>
  )
  assertRuntimeStatusCompatible(status)
  const capabilities = status.capabilities ?? []
  return {
    supported: args.requiredCapabilities.every((capability) => capabilities.includes(capability)),
    authority: Object.freeze({
      runtimeId: status.runtimeId,
      expectedEnvironmentPairingRevision,
      capabilities: Object.freeze([...capabilities])
    })
  }
}
