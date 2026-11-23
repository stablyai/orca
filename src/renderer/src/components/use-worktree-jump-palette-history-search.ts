import { useEffect, useState } from 'react'
import type { AiVaultHistorySearchMatch } from '../../../shared/ai-vault-history-types'

const EMPTY_HISTORY_MATCHES: AiVaultHistorySearchMatch[] = []

export function useWorktreeJumpPaletteHistorySearch({
  enabled,
  query,
  visible
}: {
  enabled: boolean
  query: string
  visible: boolean
}) {
  const [matches, setMatches] = useState<AiVaultHistorySearchMatch[]>(EMPTY_HISTORY_MATCHES)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const trimmedQuery = query.trim()
    if (!enabled || !visible || !trimmedQuery) {
      setMatches(EMPTY_HISTORY_MATCHES)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    void window.api.aiVault
      .searchHistory({ query: trimmedQuery, limit: 12 })
      .then((result) => {
        if (!cancelled) {
          setMatches(result.matches)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMatches(EMPTY_HISTORY_MATCHES)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled, query, visible])

  return { historyMatches: matches, historyLoading: loading }
}
