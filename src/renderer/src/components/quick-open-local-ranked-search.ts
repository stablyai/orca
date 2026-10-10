import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import type { FileExplorerOperationRoute } from '@/components/right-sidebar/file-explorer-operation-owner'

/**
 * Whether a local search index ranks quick-open paths per query for this root, so the
 * palette can ask per keystroke instead of listing and ranking every path in the renderer.
 * Null while the answer is pending; false for remote roots and when no index is available.
 * Pass a null route while the palette is not querying.
 */
export function useLocalRankedPathSearch(
  route: FileExplorerOperationRoute | null,
  rootPath: string | null
): boolean | null {
  const includeIgnored = useAppStore((state) => state.settings?.showGitIgnoredFiles ?? true)
  const followSymlinks = useAppStore((state) => state.settings?.followSymlinkedDirectories ?? false)
  const local =
    route !== null &&
    route.connectionId === undefined &&
    route.settings.activeRuntimeEnvironmentId === null
  // Hosts without the IPC (paired web, tests) answer false at once instead of waiting.
  const rankedPathSearch =
    typeof window === 'undefined' ? undefined : window.api?.fs?.rankedPathSearch
  const key =
    local && rootPath && rankedPathSearch
      ? JSON.stringify([rootPath, includeIgnored, followSymlinks])
      : ''
  const [answer, setAnswer] = useState<{ key: string; ranked: boolean } | null>(null)

  useEffect(() => {
    if (!key || !rootPath || !rankedPathSearch) {
      return
    }
    let cancelled = false
    const settle = (ranked: boolean): void => {
      if (!cancelled) {
        setAnswer({ key, ranked })
      }
    }
    rankedPathSearch({ rootPath, includeIgnored, followSymlinks }).then(
      (ranked) => settle(ranked === true),
      () => settle(false)
    )
    return () => {
      cancelled = true
    }
  }, [key, rootPath, includeIgnored, followSymlinks, rankedPathSearch])

  if (!key) {
    return false
  }
  return answer?.key === key ? answer.ranked : null
}
