import { useCallback, useEffect, useState } from 'react'
import type { GitHubAccountStatus } from '../../../../shared/github-account'

// Polls nothing by itself; the page triggers `refresh` after auth mutations.
export function useGitHubAccountStatus(): {
  status: GitHubAccountStatus | null
  loading: boolean
  refresh: () => Promise<void>
  disconnect: () => Promise<void>
} {
  const [status, setStatus] = useState<GitHubAccountStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await window.api.githubAuth.status()
      // Why: the web fallback proxy resolves `undefined` here; treat it as signed out.
      setStatus(next ?? null)
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const disconnect = useCallback(async (): Promise<void> => {
    await window.api.githubAuth.disconnect()
    await refresh()
  }, [refresh])

  return { status, loading, refresh, disconnect }
}
