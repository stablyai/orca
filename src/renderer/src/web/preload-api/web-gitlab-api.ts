import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createRuntimeGitLabApi, RuntimeCapabilityMissingError } from '@/runtime/runtime-gitlab-api'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-result'
import {
  assertEnvironmentPairing,
  callEnvironmentEnvelope,
  callRuntimeResult,
  getRemoteRuntimeStatus
} from './web-runtime-calls'
import { requireActiveEnvironment } from './web-runtime-session'

export type WebGitLabApi = NonNullable<PreloadApi['gl']>

export function createGitLabApi(): WebGitLabApi {
  // Tasks checks each project's MR list; overlapping checks for one pairing share a status, and nothing outlives it.
  const inFlightStatus = new Map<string, Promise<RuntimeStatus>>()
  const statusFor = (environmentId: string, pairingRevision: number): Promise<RuntimeStatus> => {
    const key = `${environmentId}\0${pairingRevision}`
    const existing = inFlightStatus.get(key)
    if (existing) {
      return existing
    }
    const status = callEnvironmentEnvelope<RuntimeStatus>(
      environmentId,
      'status.get',
      undefined,
      15_000,
      pairingRevision
    ).then(unwrapRuntimeRpcResult)
    inFlightStatus.set(key, status)
    void status.finally(() => inFlightStatus.delete(key)).catch(() => {})
    return status
  }
  return createRuntimeGitLabApi({
    call: async (method, params, options) => {
      if (!options?.requiredCapability) {
        return callRuntimeResult(method, params)
      }
      const environment = requireActiveEnvironment()
      const pairingRevision = environment.pairingRevision ?? environment.createdAt
      const status = await statusFor(environment.id, pairingRevision)
      // Read the answer only for the pairing that asked; a re-pair rejects instead of refusing.
      assertEnvironmentPairing(environment.id, pairingRevision)
      if (status.capabilities?.includes(options.requiredCapability) !== true) {
        throw new RuntimeCapabilityMissingError()
      }
      // Pinned to the runtime that answered, so a reconnect can't serve the call unchecked.
      return unwrapRuntimeRpcResult(
        await callEnvironmentEnvelope(
          environment.id,
          method,
          params,
          undefined,
          pairingRevision,
          status.runtimeId
        )
      )
    },
    supportsCapability: async (capability) => {
      const status = await getRemoteRuntimeStatus()
      return status.capabilities?.includes(capability) === true
    }
  })
}
