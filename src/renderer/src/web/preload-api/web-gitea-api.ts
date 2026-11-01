import type { PreloadApi } from '../../../../preload/api-types'
import { createRuntimeGiteaApi } from '@/runtime/runtime-gitea-api'
import { callRuntimeResult } from './web-runtime-calls'

export type WebGiteaApi = NonNullable<PreloadApi['gitea']>

export function createGiteaApi(): WebGiteaApi {
  return createRuntimeGiteaApi({
    call: (method, params) => callRuntimeResult(method, params)
  })
}
