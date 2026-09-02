import { useEffect, useRef, useState } from 'react'
import type {
  AiVaultSearchArgs,
  AiVaultSearchResult
} from '../../../../shared/ai-vault-search-types'

/** As-you-type pass: conversation index only, no transcript refresh. */
export const AI_VAULT_SEARCH_TYPING_DELAY_MS = 120
/** Settled pass: full index including tool output, transcripts folded in first. */
export const AI_VAULT_SEARCH_SETTLED_DELAY_MS = 400

export type AiVaultSearchRequestState = {
  result: AiVaultSearchResult | null
  loading: boolean
  error: string | null
}

type SettledSearch = {
  key: string
  result: AiVaultSearchResult | null
  error: string | null
}

/**
 * Two-tier as-you-type search.
 *
 * Why a sequence rather than an AbortSignal: neither transport can cancel an
 * in-flight index read, so both tiers stay in flight and only the newest
 * issued request may paint. The settled pass outranks the typing pass it
 * follows, so a slow conversation-tier answer can never overwrite it.
 */
export function useAiVaultSessionSearchRequest(
  args: AiVaultSearchArgs | null
): AiVaultSearchRequestState {
  const [settled, setSettled] = useState<SettledSearch | null>(null)
  const sequenceRef = useRef(0)
  // Serialized so a fresh object identity with identical values does not
  // restart the debounce on every parent render.
  const argsKey = args ? JSON.stringify(args) : ''

  useEffect(() => {
    if (!argsKey) {
      return
    }
    const requestArgs = JSON.parse(argsKey) as AiVaultSearchArgs

    const issue = (overrides: Partial<AiVaultSearchArgs>): void => {
      sequenceRef.current += 1
      const sequence = sequenceRef.current
      void window.api.aiVault
        .searchSessions({ ...requestArgs, ...overrides })
        .then((result) => {
          if (sequenceRef.current === sequence) {
            setSettled({ key: argsKey, result, error: null })
          }
        })
        .catch((error: unknown) => {
          if (sequenceRef.current === sequence) {
            setSettled({
              key: argsKey,
              result: null,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        })
    }

    const typingTimer = setTimeout(
      () => issue({ tier: 'conversation', refresh: false }),
      AI_VAULT_SEARCH_TYPING_DELAY_MS
    )
    const settledTimer = setTimeout(() => issue({ tier: 'full' }), AI_VAULT_SEARCH_SETTLED_DELAY_MS)
    return () => {
      clearTimeout(typingTimer)
      // Retires anything still in flight for the query being replaced.
      sequenceRef.current += 1
      clearTimeout(settledTimer)
    }
  }, [argsKey])

  const current = settled?.key === argsKey ? settled : null
  return {
    result: current?.result ?? null,
    loading: argsKey !== '' && current === null,
    error: current?.error ?? null
  }
}
