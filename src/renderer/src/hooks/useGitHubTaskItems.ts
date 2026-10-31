import { useMemo, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { projectViewSourceScope } from '@/store/github/cache-identity'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitHubProjectTable } from '../../../shared/github/project-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

const noopSubscribe = () => () => {}
const noopSnapshot = () => 0
/** Overlay current task records on rows at read; unchanged rows keep their identity. */
export function useGitHubTaskItems(items: readonly GitHubWorkItem[]): GitHubWorkItem[] {
  const cache = useAppStore((s) => s.githubTaskCache)
  const snapshot = useMemo(() => {
    let current: GitHubWorkItem[] = [...items]
    return () => {
      const next = items.map((item) => cache?.projectItem(item) ?? item)
      if (next.some((item, index) => item !== current[index])) {
        current = next
      }
      return current
    }
  }, [cache, items])
  return useSyncExternalStore(cache?.subscribe ?? noopSubscribe, snapshot, snapshot)
}

export function useGitHubTaskProjectTable(
  table: GitHubProjectTable | null,
  target: RuntimeClientTarget
): GitHubProjectTable | null {
  const cache = useAppStore((s) => s.githubTaskCache)
  const revision = useSyncExternalStore(
    cache?.subscribe ?? noopSubscribe,
    cache?.snapshot ?? noopSnapshot,
    cache?.snapshot ?? noopSnapshot
  )
  const scope = projectViewSourceScope(target)
  return useMemo(() => {
    void revision
    return table && cache ? cache.projectTable(table, scope) : table
  }, [cache, table, scope, revision])
}
