import type { PreloadApi } from '../../../../preload/api-types'
import { GITHUB_CACHE_STORAGE_KEY, readJson, writeJson } from './web-storage'

export function createWebGithubCacheApi(): Partial<PreloadApi> {
  return {
    cache: {
      getGitHub: () =>
        Promise.resolve(
          readJson(GITHUB_CACHE_STORAGE_KEY, {
            pr: {},
            issue: {}
          })
        ),
      setGitHub: async ({ cache }) => {
        writeJson(GITHUB_CACHE_STORAGE_KEY, cache)
      }
    }
  }
}
