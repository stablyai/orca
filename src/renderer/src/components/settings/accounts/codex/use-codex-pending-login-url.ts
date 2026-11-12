import { useEffect, useRef, useState } from 'react'

/** Login outlives Settings; read on mount as well as subscribing so reopened panes recover pending links. */
export function useCodexPendingLoginUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null)
  const publishedRef = useRef(false)

  useEffect(() => {
    let mounted = true
    publishedRef.current = false
    const unsubscribe = window.api.codexAccounts.onPendingLoginUrlChanged((next) => {
      publishedRef.current = true
      setUrl(next)
    })
    void window.api.codexAccounts
      .getPendingLoginUrl()
      .then((current) => {
        // Pushes received before this read resolves are newer.
        if (mounted && !publishedRef.current) {
          setUrl(current)
        }
      })
      .catch(() => {})
    return () => {
      mounted = false
      unsubscribe()
    }
  }, [])

  return url
}
