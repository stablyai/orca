import type { CacheEntry } from '@/store/slices/github'
import type { AsanaTask } from '../../../shared/types'

type AsanaTaskCache = Record<string, CacheEntry<AsanaTask>>
type AsanaSearchCache = Record<string, CacheEntry<AsanaTask[]>>

export function findTaskPageAsanaTask(
  asanaTaskCache: AsanaTaskCache,
  asanaSearchCache: AsanaSearchCache,
  asanaTaskGid: string | null
): AsanaTask | null {
  if (!asanaTaskGid) {
    return null
  }

  for (const entry of Object.values(asanaTaskCache)) {
    if (entry?.data?.gid === asanaTaskGid) {
      return entry.data
    }
  }

  for (const entry of Object.values(asanaSearchCache)) {
    const found = entry?.data?.find((task) => task.gid === asanaTaskGid)
    if (found) {
      return found
    }
  }

  return null
}
