import { useCallback, useMemo } from 'react'
import { signInToClaudeAccount } from '@/lib/provider-accounts/claude-account-sign-in'
import { useNativeChatViewState } from '../pane/ownership/native-chat-view-memory'
import {
  beginClaudeAccountSignIn,
  endClaudeAccountSignIn,
  useClaudeAccountSigningIn
} from './claude-account-sign-in-pending'
import type { NativeChatSignIn } from './native-chat-host-setup'

/** Offer selected-account sign-in until successful, then report signed in until the failure or failure-row count changes. */
export function useManagedClaudeSignIn(
  accountId: string | null,
  failure: unknown,
  failureRows: number
): NativeChatSignIn | null {
  // Per account, read synchronously: the notice and a transcript row both sign in, and a second press from any
  // view, a remounted one included, would cancel the first login.
  const signingIn = useClaudeAccountSigningIn(accountId)
  // Kept with the chat tab: a sign-in that finishes while the chat is switched away still shows on return.
  const [signedInFor, setSignedInFor] = useNativeChatViewState<{
    accountId: string
    failure: unknown
    rows: number
  } | null>('claude-signed-in', null)
  const signIn = useCallback(() => {
    if (!accountId || !beginClaudeAccountSignIn(accountId)) {
      return
    }
    void signInToClaudeAccount(accountId)
      .then((signedIn) => {
        if (signedIn) {
          setSignedInFor({ accountId, failure, rows: failureRows })
        }
      })
      .finally(() => endClaudeAccountSignIn(accountId))
  }, [accountId, failure, failureRows, setSignedInFor])
  const signedInSinceFailure =
    signedInFor !== null &&
    signedInFor.accountId === accountId &&
    signedInFor.failure === failure &&
    signedInFor.rows === failureRows
  // Why memoized: rows read it through context, and a chat re-renders on every streamed token.
  return useMemo(
    () => (accountId ? { signingIn, signedIn: signedInSinceFailure, signIn } : null),
    [accountId, signedInSinceFailure, signingIn, signIn]
  )
}
