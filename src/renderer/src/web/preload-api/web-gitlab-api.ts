import type { PreloadApi } from '../../../../preload/api-types'
import { createRuntimeGitLabApi, GITLAB_RPC_TIMEOUT_MS } from '@/runtime/runtime-gitlab-api'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'

export type WebGitLabApi = NonNullable<PreloadApi['gl']>

export function createGitLabApi(): WebGitLabApi {
  return createRuntimeGitLabApi({
    call: (method, params, signal) =>
      signal
        ? callRuntimeResult(method, params, GITLAB_RPC_TIMEOUT_MS, signal)
        : callRuntimeResult(method, params),
    supportsCapability: async (capability) => {
      const status = await getRemoteRuntimeStatus().catch(() => null)
      return status?.capabilities?.includes(capability) === true
    }
  })
}
