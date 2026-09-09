import type { PreloadApi } from '../../../../preload/api-types'
import { getBrowserPlatform } from './web-storage'

export function createWebPlatformApi(): Partial<PreloadApi> {
  return {
    platform: {
      get: () => ({
        platform: getBrowserPlatform(),
        osRelease: '',
        arch: '',
        shell: '',
        displayServer: null
      })
    }
  }
}
