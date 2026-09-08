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
  /** The held answer is for the query on screen; a retained older answer is not. */
  current: boolean
  error: string | null
  flush: () => void
}

type SettledSearch = {
  ownerKey: string
  full: boolean
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
  ownerKey = ''
): AiVaultSearchRequestState {
  const [settled, setSettled] = useState<SettledSearch | null>(null)
  const sequenceRef = useRef(0)
  // Serialized so a fresh object identity with identical values does not
  // restart the debounce on every parent render.
  const argsKey = args ? JSON.stringify(args) : ''

  const issue = useCallback(
    (key: string, overrides: Partial<AiVaultSearchArgs>): void => {
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
            setSettled({ ownerKey, key, result, error: null, full: overrides.tier === 'full' })
          }
        })
        .catch((error: unknown) => {
          if (sequenceRef.current === sequence) {
            setSettled({
              ownerKey,
              key,
              full: true,
              result: null,
              error: error instanceof Error ? error.message : String(error)
            })
          }
        })
    },
    [ownerKey]
  )

  // Enter cancels both timers before issuing the full query.
  const cancelDebounceRef = useRef<() => void>(() => undefined)

  useEffect(() => {
    if (!argsKey) {
      return
    }
    const typingTimer = setTimeout(
      () => issue(argsKey, { tier: 'conversation', refresh: false }),
      AI_VAULT_SEARCH_TYPING_DELAY_MS
    )
    const settledTimer = setTimeout(
      () => issue(argsKey, { tier: 'full' }),
      AI_VAULT_SEARCH_SETTLED_DELAY_MS
    )
    const cancel = (): void => {
      clearTimeout(typingTimer)
      clearTimeout(settledTimer)
    }
    cancelDebounceRef.current = cancel
    return () => {
      cancel()
      cancelDebounceRef.current = () => undefined
      // Retires anything still in flight for the query being replaced.
      sequenceRef.current += 1
    }
  }, [argsKey, issue])

  const flush = useCallback(() => {
    cancelDebounceRef.current()
    issue(argsKey, { tier: 'full' })
  }, [argsKey, issue])

  const owned = settled?.ownerKey === ownerKey ? settled : null
  const current = owned?.key === argsKey ? owned : null
  const previous = current === null && argsKey !== '' ? (owned?.result ?? null) : null
  return {
    flush,
    result: current?.result ?? previous,
    loading: argsKey !== '' && current === null && previous === null,
    current: current !== null,
    error: current?.error ?? null
  }
}
