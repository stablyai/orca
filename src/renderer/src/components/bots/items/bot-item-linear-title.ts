// A Linear link's title from Orca's Linear cache, as the Links block has always shown it.
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

// Each cache the store holds, its titles by upper-cased identifier: built once per cache, shared by
// every Linear row, so a store write elsewhere costs a row one lookup, not a scan of the cache.
const linearTitlesByCache = new WeakMap<AppState['linearIssueCache'], ReadonlyMap<string, string>>()

function linearTitles(cache: AppState['linearIssueCache']): ReadonlyMap<string, string> {
  let titles = linearTitlesByCache.get(cache)
  if (!titles) {
    const byIdentifier = new Map<string, string>()
    for (const entry of Object.values(cache)) {
      const identifier = entry?.data?.identifier.toUpperCase()
      if (identifier && entry?.data && !byIdentifier.has(identifier)) {
        byIdentifier.set(identifier, entry.data.title)
      }
    }
    titles = byIdentifier
    linearTitlesByCache.set(cache, titles)
  }
  return titles
}

/** A Linear issue's title, when Orca's Linear cache has read it; never a fetch of its own. */
export function useLinearTitle(identifier: string | null): string | null {
  return useAppStore((state) =>
    identifier ? (linearTitles(state.linearIssueCache).get(identifier) ?? null) : null
  )
}
