import type { AppState } from '../types'

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Schedules the renderer's single trailing GitHub cache persistence write. */
export function debouncedSaveCache(state: AppState): void {
  clearTimeout(saveTimer ?? undefined)
  saveTimer = setTimeout(() => {
    saveTimer = null
    window.api.cache.setGitHub({
      cache: {
        pr: state.prCache,
        issue: state.issueCache
      }
    })
  }, 1000)
}
