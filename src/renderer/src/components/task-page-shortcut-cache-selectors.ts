import type { CacheEntry } from '@/store/slices/github'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import type { ShortcutStory } from '../../../shared/shortcut-types'

type ShortcutStoryCache = Record<string, CacheEntry<ShortcutStory | null>>
type ShortcutSearchCache = Record<string, CacheEntry<ShortcutStory[]>>

export type TaskPageShortcutStoryLookupOptions = {
  sourceContext?: TaskSourceContext | null
  workspaceId?: string | null
}

export function findTaskPageShortcutStory(
  shortcutStoryCache: ShortcutStoryCache,
  shortcutSearchCache: ShortcutSearchCache,
  storyId: string | null,
  options: TaskPageShortcutStoryLookupOptions = {}
): ShortcutStory | null {
  if (!storyId) {
    return null
  }
  const sourceScope =
    options.sourceContext?.provider === 'shortcut'
      ? getTaskSourceCacheScope(options.sourceContext)
      : null
  const matchesLookup = (cacheKey: string, story: ShortcutStory | null | undefined): boolean => {
    if (!story || story.id !== storyId) {
      return false
    }
    if (options.workspaceId && story.workspaceId !== options.workspaceId) {
      return false
    }
    // Why: Shortcut story ids are only unique within a workspace, so drawer
    // lookup must not borrow a same-id story cached for another account.
    return sourceScope === null || cacheKey.startsWith(`${sourceScope}::`)
  }

  for (const [cacheKey, entry] of Object.entries(shortcutStoryCache)) {
    if (matchesLookup(cacheKey, entry?.data)) {
      return entry.data
    }
  }

  for (const [cacheKey, entry] of Object.entries(shortcutSearchCache)) {
    const found = entry?.data?.find((story) => matchesLookup(cacheKey, story))
    if (found) {
      return found
    }
  }

  return null
}
