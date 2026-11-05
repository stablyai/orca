import type { PreloadApi } from '../../../../preload/api-types'
import { createRuntimeGitLabApi } from '@/runtime/runtime-gitlab-api'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'

export type WebGitLabApi = NonNullable<PreloadApi['gl']>

export function createGitLabApi(): WebGitLabApi {
  return createRuntimeGitLabApi({
    call: (method, params) => callRuntimeResult(method, params),
    supportsCapability: async (capability) => {
      const status = await getRemoteRuntimeStatus().catch(() => null)
      return status?.capabilities?.includes(capability) === true
    }
  })
}
