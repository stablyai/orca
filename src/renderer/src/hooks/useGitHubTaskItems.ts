import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

const noopSubscribe = () => () => {}
export function useGitHubTaskItems(items: readonly GitHubWorkItem[]): GitHubWorkItem[] {
  const cache = useAppStore((s) => s.githubTaskCache)
  const snapshot = useMemo(() => {
    let current: GitHubWorkItem[] = [...items]
    return () => {
      const next = items
        .filter((item) => !cache || cache.isObservedCurrent(item))
        .map((item) => cache?.projectObserved(item) ?? item)
      if (next.length !== current.length || next.some((item, index) => item !== current[index])) {
        current = next
      }
      return current
    }
  }, [cache, items])
  useEffect(() => {
    const releases = items.map((item) => cache?.pinObserved(item))
    return () => {
      for (const release of releases) {
        release?.()
      }
    }
  }, [cache, items])
  return useSyncExternalStore(cache?.subscribe ?? noopSubscribe, snapshot, snapshot)
}
