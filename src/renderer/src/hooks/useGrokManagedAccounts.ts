import { useCallback, useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { GrokAccountsState } from '../../../shared/grok-account-types'

export function useGrokManagedAccounts({
  enabled = true,
  updatedAt
}: {
  enabled?: boolean
  updatedAt?: number
} = {}) {
  const [state, setState] = useState<GrokAccountsState | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef(0)
  const operationPending = useRef(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!enabled || operationPending.current) {
      return
    }
    const generation = ++request.current
    setLoading(true)
    void window.api.grokAccounts
      .list()
      .then((next) => {
        if (!cancelled && generation === request.current) {
          setState(next)
          setError(null)
        }
      })
      .catch(() => {
        if (!cancelled && generation === request.current) {
          setError(translate('grokAccounts.loadFailed', 'Unable to load saved Grok accounts.'))
        }
      })
      .finally(() => {
        if (!cancelled && generation === request.current) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled, updatedAt])

  const run = useCallback(
    async (operation: () => Promise<GrokAccountsState>, login = false): Promise<void> => {
      if (!enabled || operationPending.current) {
        return
      }
      operationPending.current = true
      request.current++
      setLoading(false)
      setBusy(true)
      setSigningIn(login)
      setError(null)
      try {
        const next = await operation()
        if (mounted.current) {
          setState(next)
        }
      } catch (value) {
        if (mounted.current) {
          setError(
            value instanceof Error
              ? value.message
              : translate('grokAccounts.changeFailed', 'Unable to change the Grok account.')
          )
        }
      } finally {
        operationPending.current = false
        if (mounted.current) {
          setBusy(false)
          setSigningIn(false)
        }
      }
    },
    [enabled]
  )

  return { state, loading, busy, signingIn, error, run }
}
