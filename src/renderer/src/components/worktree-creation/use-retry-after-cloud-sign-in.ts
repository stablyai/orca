import React from 'react'
import { useAppStore } from '@/store'

/** True when Orca sign-in just completed: the card's promise is "sign in and Orca starts this one". */
export function signedInSince(
  previous: string | null | undefined,
  next: string | null | undefined
): boolean {
  return next === 'connected' && previous !== 'connected'
}

/**
 * While the build shows "Sign in to use Orca Cloud", retry once as soon as sign-in completes,
 * whether from the card or anywhere else (account menu, Settings). Without this the card stayed up
 * after signing in elsewhere. Returns the deduped retry for the card's own Sign in button.
 */
export function useRetryAfterCloudSignIn(
  waitingForSignIn: boolean,
  onRetry: () => void
): () => void {
  const retried = React.useRef(false)
  const onRetryRef = React.useRef(onRetry)
  React.useEffect(() => {
    onRetryRef.current = onRetry
  }, [onRetry])
  const retryOnce = React.useCallback(() => {
    if (retried.current) {
      return
    }
    retried.current = true
    onRetryRef.current()
  }, [])
  React.useEffect(() => {
    if (!waitingForSignIn) {
      return
    }
    // Each sign-in wait gets one retry; a retry that fails for sign-in again shows the card again.
    retried.current = false
    return useAppStore.subscribe((state, previous) => {
      if (
        signedInSince(previous.orcaProfileAuthStatus?.state, state.orcaProfileAuthStatus?.state)
      ) {
        retryOnce()
      }
    })
  }, [waitingForSignIn, retryOnce])
  return retryOnce
}
