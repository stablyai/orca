import { useCallback, useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import type { OrcaAccountMfa } from '../../../../../../shared/orca-account-mfa'

/** Re-check every few seconds after the browser opened, for at most five minutes. */
export const ACCOUNT_MFA_POLL_MS = 3_000
export const ACCOUNT_MFA_WATCH_MAX_MS = 5 * 60_000

export type AccountMfaState =
  /** Not read yet, every read failed, or this deployment has no MFA status: the row is hidden. */
  | { kind: 'unknown' }
  | ({ kind: 'known' } & OrcaAccountMfa)

export type AccountMfa = {
  state: AccountMfaState
  /** Opens the account's security page in the browser, then watches for the change. */
  openSetup: () => void
}

/**
 * The signed-in person's own two-factor state (mount only while signed in to Orca Cloud). Read on
 * mount and when the window regains focus; polled lightly after the browser was opened, since the
 * person enrols there and comes back.
 */
export function useAccountMfa(): AccountMfa {
  const [state, setState] = useState<AccountMfaState>({ kind: 'unknown' })
  const [watching, setWatching] = useState<'on' | 'off' | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    let result: Awaited<ReturnType<typeof window.api.orcaProfiles.accountMfa>> | null
    try {
      result = (await window.api.orcaProfiles.accountMfa()) ?? null
    } catch {
      result = null
    }
    // A failed read keeps what the row shows; the next focus or poll tries again.
    if (result?.status === 'ok') {
      setState({ kind: 'known', mfa: result.mfa, setupUrl: result.setupUrl })
    }
  }, [])

  useEffect(() => {
    void refresh()
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

  // Stop watching once the state differs from what it was when the browser opened.
  const changed = watching !== null && state.kind === 'known' && state.mfa !== watching
  useEffect(() => {
    if (changed) {
      setWatching(null)
    }
  }, [changed])

  useEffect(() => {
    if (watching === null) {
      return
    }
    const stopPolling = installWindowVisibilityInterval({
      run: () => void refresh(),
      intervalMs: ACCOUNT_MFA_POLL_MS
    })
    const expire = setTimeout(() => setWatching(null), ACCOUNT_MFA_WATCH_MAX_MS)
    return () => {
      stopPolling()
      clearTimeout(expire)
    }
  }, [watching, refresh])

  const openSetup = useCallback((): void => {
    if (state.kind !== 'known') {
      return
    }
    void window.api.shell.openUrl(state.setupUrl)
    setWatching(state.mfa)
  }, [state])

  return { state, openSetup }
}
