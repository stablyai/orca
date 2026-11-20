import type { PreloadApi } from '../../../../../preload/api-types'
import { createRuntimeGiteaApi } from '@/runtime/repository-gitea/runtime-gitea-api'
import { callRuntimeResult } from '../../runtime/client/web-runtime-calls'

export type WebGiteaApi = NonNullable<PreloadApi['gitea']>

export function createGiteaApi(): WebGiteaApi {
  return createRuntimeGiteaApi({
    call: (method, params) => callRuntimeResult(method, params)
  })
}
