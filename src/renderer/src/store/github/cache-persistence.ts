import type { AppState } from '../types'

let saveTimer: ReturnType<typeof setTimeout> | null = null

/** Schedules the renderer's single trailing GitHub cache persistence write. */
export function debouncedSaveCache(state: AppState): void {
  clearTimeout(saveTimer ?? undefined)
  // Keep unrelated renderer state out of the pending timer's closure.
  const { prCache, issueCache } = state
  saveTimer = setTimeout(() => {
    saveTimer = null
    window.api.cache.setGitHub({
      cache: {
        pr: prCache,
        issue: issueCache
      }
    })
  }, 1000)
}
