import { useEffect } from 'react'
import { useAppStore } from '@/store'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { REPO_PATH_STATUS_TTL_MS } from '../../../../shared/repo-path-status'

/**
 * Checks registered repo folders when the catalog changes and when the window regains focus,
 * the moment a user who moved a folder elsewhere comes back. No interval: nothing moves a folder
 * while Orca has focus that Orca itself does not know about.
 */
export function useRepoPathStatusRefresh(): void {
  const refresh = useAppStore((s) => s.refreshRepoPathStatuses)
  const catalogKey = useAppStore((s) =>
    s.repos.map((repo) => `${getRepoExecutionHostId(repo)}\0${repo.id}\0${repo.path}`).join('\n')
  )

  useEffect(() => {
    if (catalogKey) {
      void refresh()
    }
  }, [catalogKey, refresh])

  useEffect(() => {
    let lastCheckAt = 0
    const onReturn = (): void => {
      const now = Date.now()
      if (document.visibilityState === 'hidden' || now - lastCheckAt < REPO_PATH_STATUS_TTL_MS) {
        return
      }
      lastCheckAt = now
      void refresh()
    }
    window.addEventListener('focus', onReturn)
    document.addEventListener('visibilitychange', onReturn)
    return () => {
      window.removeEventListener('focus', onReturn)
      document.removeEventListener('visibilitychange', onReturn)
    }
  }, [refresh])
}
