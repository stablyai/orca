import type { PreloadApi } from '../../../../preload/api-types'
import { createRuntimeGitLabApi } from '@/runtime/runtime-gitlab-api'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'

export type WebGitLabApi = NonNullable<PreloadApi['gl']>

// Tasks gates each project's MR list on a capability; a refresh reuses one recent status
// instead of asking per project. Failures are never reused so a timeout can't stick.
const STATUS_REUSE_MS = 30_000

export function createGitLabApi(): WebGitLabApi {
  let recentStatus: {
    promise: ReturnType<typeof getRemoteRuntimeStatus>
    at: number
  } | null = null
  return createRuntimeGitLabApi({
    call: (method, params) => callRuntimeResult(method, params),
    supportsCapability: async (capability) => {
      if (!recentStatus || Date.now() - recentStatus.at > STATUS_REUSE_MS) {
        const entry = { promise: getRemoteRuntimeStatus(), at: Date.now() }
        recentStatus = entry
        entry.promise.catch(() => {
          if (recentStatus === entry) {
            recentStatus = null
          }
        })
      }
      const status = await recentStatus.promise.catch(() => null)
      return status?.capabilities?.includes(capability) === true
    }
  })
}
