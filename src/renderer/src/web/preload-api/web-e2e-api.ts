import type { PreloadApi } from '../../../../preload/api-types'
import { webE2EConfig } from './web-e2e-config'

export function createWebE2EApi(): Partial<PreloadApi> {
  return {
    e2e: {
      getConfig: () => webE2EConfig
    }
  }
}
