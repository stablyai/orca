import { useCallback, useEffect, useReducer, useState } from 'react'
import {
  GITHUB_IDENTITY_PENDING_MAX_MS,
  GITHUB_IDENTITY_POLL_MS,
  gitHubIdentityReducer,
  initialGitHubIdentityState,
  type GitHubIdentityState
} from './github-identity-model'

/** A bridge call that never throws: a missing bridge or a rejected call reads as no answer. */
async function bridgeCall<T>(call: () => Promise<T>): Promise<T | null> {
  try {
    return (await call()) ?? null
  } catch {
    return null
  }
}

export type GitHubIdentity = {
  state: GitHubIdentityState
  disconnecting: boolean
  connect: () => Promise<void>
  cancel: () => void
  /** Asks first (`confirm`); disconnects only on yes. */
  disconnect: () => Promise<void>
  /** After a failed Disconnect: tries again without asking, since it was already confirmed. */
  retryDisconnect: () => Promise<void>
}

/**
 * The person's own GitHub connection for Orca Cloud commits (mounted only while signed in to Orca
 * Cloud). Reads it on mount, again when the window regains focus, and polls lightly while the
 * browser OAuth is open.
 */
export function useGitHubIdentity(confirm: () => Promise<boolean>): GitHubIdentity {
  const [state, dispatch] = useReducer(gitHubIdentityReducer, initialGitHubIdentityState)
  const [disconnecting, setDisconnecting] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    const result = await bridgeCall(() => window.api.orcaCloudWorkspace.getGitHubUser())
    // A failed read keeps what the row shows; the next focus or poll tries again.
    if (result?.ok === true && typeof result.value?.connected === 'boolean') {
      dispatch({ type: 'status', user: result.value })
    }
  }, [])

  useEffect(() => {
    void refresh()
    // The OAuth finishes in the browser; coming back to Orca is the moment to look again.
    const onFocus = (): void => void refresh()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh])

  const pending = state.kind === 'pending'
  useEffect(() => {
    if (!pending) {
      return
    }
    const poll = setInterval(() => void refresh(), GITHUB_IDENTITY_POLL_MS)
    const expire = setTimeout(
      () => dispatch({ type: 'pendingExpired' }),
      GITHUB_IDENTITY_PENDING_MAX_MS
    )
    return () => {
      clearInterval(poll)
      clearTimeout(expire)
    }
  }, [pending, refresh])

  const connect = useCallback(async (): Promise<void> => {
    dispatch({ type: 'connectStarted' })
    const result = await bridgeCall(() => window.api.orcaCloudWorkspace.connectGitHubUser())
    if (result?.ok !== true) {
      dispatch({ type: 'connectFailed' })
    }
  }, [])

  const cancel = useCallback((): void => dispatch({ type: 'cancel' }), [])

  const runDisconnect = useCallback(async (): Promise<void> => {
    setDisconnecting(true)
    const result = await bridgeCall(() => window.api.orcaCloudWorkspace.disconnectGitHubUser())
    setDisconnecting(false)
    // Failed: still connected as far as we know, and the row says the disconnect didn't happen.
    dispatch({ type: result?.ok === true ? 'disconnected' : 'disconnectFailed' })
  }, [])

  const disconnect = useCallback(async (): Promise<void> => {
    if (await confirm()) {
      await runDisconnect()
    }
  }, [confirm, runDisconnect])

  return { state, disconnecting, connect, cancel, disconnect, retryDisconnect: runDisconnect }
}
