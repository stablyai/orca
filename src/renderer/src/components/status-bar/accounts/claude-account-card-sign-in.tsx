import { useRef, useState } from 'react'
import type React from 'react'
import { useAppStore } from '../../../store/index'
import { signInToClaudeAccount } from '@/lib/provider-accounts/claude-account-sign-in'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { InlineUsageSignInAction } from '../usage/InlineProviderUsage'
import { TriangleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

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

/** The account card's status when the card's account read as signed out: one row with its Sign in button. */
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
    <ClaudeAccountCardSignedOut
      accountLabel={target.label}
      isSigningIn={signingInId === accountId}
      disabled={disabled || signingInId !== null}
      onSignIn={() => onSignIn(accountId)}
    />
  )
}

function ClaudeAccountCardSignedOut({
  accountLabel,
  isSigningIn,
  disabled,
  onSignIn
}: {
  accountLabel: string
  isSigningIn: boolean
  disabled: boolean
  onSignIn: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const message = t(
    'accounts.claude.usageSignInMessage',
    'This account needs you to sign in again.'
  )
  return (
    <div className="flex items-center justify-between gap-3">
      <div role="status" className="flex min-w-0 items-center gap-1.5" title={message}>
        <TriangleAlert aria-hidden className="size-3.5 shrink-0 text-status-warning-text" />
        <span className="truncate text-[13px] font-medium">
          {t('auto.components.status.bar.StatusBar.signedOutAccounts', 'Signed out')}
        </span>
        <span className="sr-only">{message}</span>
      </div>
      <InlineUsageSignInAction
        accountLabel={accountLabel}
        isSigningIn={isSigningIn}
        disabled={disabled}
        onSignIn={onSignIn}
        showBusyLabel
      />
    </div>
  )
}
