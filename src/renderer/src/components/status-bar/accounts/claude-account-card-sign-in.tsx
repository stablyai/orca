import { useRef, useState } from 'react'
import type React from 'react'
import { useAppStore } from '../../../store/index'
import { signInToClaudeAccount } from '@/lib/provider-accounts/claude-account-sign-in'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { InlineUsageSignInAction } from '../usage/InlineProviderUsage'

/** Runs one account's hidden re-authentication at a time and reloads the rows after it lands. */
export function useClaudeAccountSignIn(
  loadAccounts: () => Promise<unknown>,
  mountedRef: { current: boolean }
): { signingInId: string | null; handleSignIn: (accountId: string) => Promise<void> } {
  const [signingInId, setSigningInId] = useState<string | null>(null)
  const signingInRef = useRef(false)
  const handleSignIn = async (accountId: string): Promise<void> => {
    // Why a ref: the row and its button both sign in, and state lags a double press.
    if (signingInRef.current) {
      return
    }
    signingInRef.current = true
    setSigningInId(accountId)
    try {
      if (await signInToClaudeAccount(accountId)) {
        await loadAccounts()
      }
    } finally {
      signingInRef.current = false
      if (mountedRef.current) {
        setSigningInId(null)
      }
    }
  }
  return { signingInId, handleSignIn }
}

/** Opens Settings on the Claude accounts section of the host these rows belong to. */
export function useOpenClaudeAccountSettings(
  runtimeTarget: RuntimeClientTarget,
  nativeAccounts: boolean
): () => void {
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  return () => {
    openSettingsTarget({
      pane: 'accounts',
      repoId: null,
      sectionId: 'accounts-claude',
      // Why: without a scope Settings opens on the default host, not the one these rows belong to.
      hostScope: runtimeTarget,
      ...(nativeAccounts ? { intent: 'native-accounts' } : {})
    })
    openSettingsPage()
  }
}

/** The account card's Sign in button, shown when the card's account read as signed out. */
export function claudeAccountCardSignIn({
  claude,
  target,
  signingInId,
  disabled,
  onSignIn
}: {
  claude: ProviderRateLimits | null
  /** The account the card shows, if any. */
  target: { id: string | null; label: string } | undefined
  signingInId: string | null
  disabled: boolean
  onSignIn: (accountId: string) => void
}): React.ReactNode {
  // Why: the host reports this only for a selected account whose own profile has no login.
  const accountId = target?.id
  if (claude?.usageMetadata?.failureKind !== 'missing-credentials' || !target || !accountId) {
    return undefined
  }
  return (
    <InlineUsageSignInAction
      accountLabel={target.label}
      isSigningIn={signingInId === accountId}
      disabled={disabled || signingInId !== null}
      onSignIn={() => onSignIn(accountId)}
    />
  )
}
