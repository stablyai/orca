import type { PreloadApi } from '../../../../preload/api-types'
import type { RuntimeStatus } from '../../../../shared/runtime-types'
import { createRuntimeGitLabApi, RuntimeCapabilityMissingError } from '@/runtime/runtime-gitlab-api'
import {
  callEnvironmentEnvelope,
  callRuntimeResult,
  getRemoteRuntimeStatus
} from './web-runtime-calls'
import { requireActiveEnvironment } from './web-runtime-session'

export type WebGitLabApi = NonNullable<PreloadApi['gl']>

function resultOrThrow<TResult>(
  response: Awaited<ReturnType<typeof callEnvironmentEnvelope<TResult>>>
): TResult {
  if (!response.ok) {
    throw Object.assign(new Error(response.error.message), { code: response.error.code })
  }
  return response.result
}

export function createGitLabApi(): WebGitLabApi {
  // Tasks checks each project's MR list; overlapping checks share one status, and nothing outlives it.
  const inFlightStatus = new Map<string, Promise<RuntimeStatus>>()
  const statusFor = (environmentId: string): Promise<RuntimeStatus> => {
    const existing = inFlightStatus.get(environmentId)
    if (existing) {
      return existing
    }
    const status = callEnvironmentEnvelope<RuntimeStatus>(
      environmentId,
      'status.get',
      undefined,
      15_000
    ).then(resultOrThrow)
    inFlightStatus.set(environmentId, status)
    void status.finally(() => inFlightStatus.delete(environmentId)).catch(() => {})
    return status
  }
  return createRuntimeGitLabApi({
    call: async (method, params, options) => {
      if (!options?.requiredCapability) {
        return callRuntimeResult(method, params)
      }
      const environment = requireActiveEnvironment()
      const status = await statusFor(environment.id)
      if (status.capabilities?.includes(options.requiredCapability) !== true) {
        throw new RuntimeCapabilityMissingError()
      }
      // Pinned to the runtime that answered, so a reconnect or re-pair can't serve the call unchecked.
      return resultOrThrow(
        await callEnvironmentEnvelope(
          environment.id,
          method,
          params,
          undefined,
          environment.pairingRevision ?? environment.createdAt,
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
