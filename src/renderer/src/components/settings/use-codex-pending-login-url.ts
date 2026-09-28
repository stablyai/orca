import { useEffect, useRef, useState } from 'react'

/**
 * The sign-in link of the Codex login currently waiting on a browser, or null.
 *
 * Reads the current value on mount as well as subscribing: the login starts in
 * the main process and keeps running while Settings is closed, so a pane that
 * opens midway through one would otherwise never see the link.
 */
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
        // Why: a push can land before this read resolves; the push is newer.
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
