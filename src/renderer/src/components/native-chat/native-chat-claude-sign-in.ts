import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { signInToClaudeAccount } from '@/lib/claude-account-sign-in'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

const SIGN_IN_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'notSignedIn',
  'claudeAccountFolderMissing'
])

export function isClaudeSignInFailureKind(kind: string | undefined): boolean {
  return kind !== undefined && SIGN_IN_FAILURE_KINDS.has(kind)
}

export type NativeChatClaudeSignIn = { signingIn: boolean; signIn: () => void }

export const NativeChatClaudeSignInContext = createContext<NativeChatClaudeSignIn | null>(null)

export function useNativeChatClaudeSignInView(): NativeChatClaudeSignIn | null {
  return useContext(NativeChatClaudeSignInContext)
}

export function nativeChatClaudeSignInLabel(signIn: NativeChatClaudeSignIn): string {
  return signIn.signingIn
    ? translate('components.native-chat.claudeSignIn.signingIn', 'Signing in…')
    : translate('accounts.claude.signIn', 'Sign in')
}

/** Offer local selected-account sign-in until successful, then suppress it until the failure or failure-row count changes. */
export function useNativeChatClaudeSignIn(input: {
  agent: string
  target: RuntimeClientTarget
  failure: unknown
  failureRows: number
}): NativeChatClaudeSignIn | null {
  // Why local only: the hidden sign-in runs on this device, and Claude chats run on its host.
  const accountId = useAppStore((s) =>
    input.agent === 'claude' && input.target.kind === 'local'
      ? (s.settings?.activeClaudeManagedAccountIdsByRuntime?.host ??
        s.settings?.activeClaudeManagedAccountId ??
        null)
      : null
  )
  const [signingIn, setSigningIn] = useState(false)
  // Why a ref: the notice and a transcript row both sign in, and state lags a double press.
  const signingInRef = useRef(false)
  const [signedInFor, setSignedInFor] = useState<{ failure: unknown; rows: number } | null>(null)
  const { failure, failureRows } = input
  const signIn = useCallback(() => {
    if (!accountId || signingInRef.current) {
      return
    }
    signingInRef.current = true
    setSigningIn(true)
    void signInToClaudeAccount(accountId)
      .then((signedIn) => {
        if (signedIn) {
          setSignedInFor({ failure, rows: failureRows })
        }
      })
      .finally(() => {
        signingInRef.current = false
        setSigningIn(false)
      })
  }, [accountId, failure, failureRows])
  const signedInSinceFailure =
    signedInFor !== null && signedInFor.failure === failure && signedInFor.rows === failureRows
  // Why memoized: rows read it through context, and a chat re-renders on every streamed token.
  return useMemo(
    () => (accountId && !signedInSinceFailure ? { signingIn, signIn } : null),
    [accountId, signedInSinceFailure, signingIn, signIn]
  )
}
