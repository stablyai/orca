import { useCallback, useEffect, useRef, useState } from 'react'
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
  /** No answer for any query yet; the list should show its spinner. */
  loading: boolean
  /** An answer is on screen but a newer query is still in flight. */
  updating: boolean
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
 *
 * The previous answer keeps rendering while the next query is in flight.
 * Clearing it per keystroke let the fast tier paint an empty list before the
 * full tier reordered it, which read as results vanishing and returning.
 */
export function useAiVaultSessionSearchRequest(
  args: AiVaultSearchArgs | null,
  /** Bumped on Enter: runs the full tier now instead of waiting out the debounce. */
  flushSignal = 0
): AiVaultSearchRequestState {
  const [settled, setSettled] = useState<SettledSearch | null>(null)
  const sequenceRef = useRef(0)
  // Serialized so a fresh object identity with identical values does not
  // restart the debounce on every parent render.
  const argsKey = args ? JSON.stringify(args) : ''
  const argsKeyRef = useRef(argsKey)
  argsKeyRef.current = argsKey

  const issue = useCallback((overrides: Partial<AiVaultSearchArgs>): void => {
    const key = argsKeyRef.current
    if (!key) {
      return
    }
    const requestArgs = JSON.parse(key) as AiVaultSearchArgs
    sequenceRef.current += 1
    const sequence = sequenceRef.current
    void window.api.aiVault
      .searchSessions({ ...requestArgs, ...overrides })
      .then((result) => {
        if (sequenceRef.current === sequence) {
          setSettled({ key, result, error: null })
        }
      })
      .catch((error: unknown) => {
        if (sequenceRef.current === sequence) {
          setSettled({
            key,
            result: null,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
  }, [])

  useEffect(() => {
    if (!argsKey) {
      return
    }
    const typingTimer = setTimeout(
      () => issue({ tier: 'conversation', refresh: false }),
      AI_VAULT_SEARCH_TYPING_DELAY_MS
    )
    const settledTimer = setTimeout(() => issue({ tier: 'full' }), AI_VAULT_SEARCH_SETTLED_DELAY_MS)
    return () => {
      clearTimeout(typingTimer)
      clearTimeout(settledTimer)
      // Retires anything still in flight for the query being replaced.
      sequenceRef.current += 1
    }
  }, [argsKey, issue])

  useEffect(() => {
    if (flushSignal > 0) {
      issue({ tier: 'full' })
    }
  }, [flushSignal, issue])

  const current = settled?.key === argsKey ? settled : null
  const previous = current === null && argsKey !== '' ? (settled?.result ?? null) : null
  return {
    result: current?.result ?? previous,
    loading: argsKey !== '' && current === null && previous === null,
    updating: argsKey !== '' && current === null,
    error: current?.error ?? null
  }
}
