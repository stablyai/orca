import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { isCodexUsageSignInRequired } from '../../../../../shared/agent-accounts/codex/codex-auth-errors'
import {
  buildActiveCodexResetCreditExpectedScope,
  type CodexResetCreditExpectedScope
} from '../../../../../shared/agent-accounts/codex/codex-reset-credit-scope'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  consumeHostCodexResetCredit,
  hasUnansweredHostCodexReset,
  hostSupportsCodexResetCredit
} from '@/runtime/provider-accounts/usage/runtime-codex-reset-credit-client'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { getCodexResetProjection } from './codex-switcher-projection'

async function redeemLoggingFailure(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    console.error('Failed to redeem Codex rate-limit reset from status bar:', error)
  }
}

/** The status bar's Codex reset: this desktop's login locally, the owning host's account remotely. */
export function useCodexResetAction(
  codex: ProviderRateLimits,
  hostEnvironmentId: string | null,
  hostSnapshot: ProviderAccountsSnapshot | null,
  menuOpen: boolean,
  enabled = true
) {
  const t = useTranslate()
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [skipFutureResetConfirm, setSkipFutureResetConfirm] = useState(false)
  const [isRedeemingReset, setIsRedeemingReset] = useState(false)
  const [hostSupport, setHostSupport] = useState<{
    environmentId: string
    supported: boolean
  } | null>(null)
  const [confirmedScope, setConfirmedScope] = useState<CodexResetCreditExpectedScope | null>(null)
  const mountedRef = useRef(true)
  const resetConfirmationRevision = useRef(0)
  const skipResetConfirm = useAppStore((s) => s.settings?.skipCodexRateLimitResetConfirm === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const consumeLocalResetCredit = useAppStore((s) => s.consumeCodexRateLimitResetCredit)
  const resetBlocked =
    codex.status === 'fetching' || (codex.status === 'error' && isCodexUsageSignInRequired(codex))
  const offerCount = codex.rateLimitResetCredits?.availableCount ?? 0
  // Why: a confirmation names the offer it was opened for; a refresh that changes it must not spend.
  const offerKey = `${offerCount}:${codex.rateLimitResetCredits?.nextExpiresAt ?? ''}`
  const offerAvailable = !resetBlocked && offerCount > 0
  const offerAvailableRef = useRef(offerAvailable)

  // Why: scope the host's spend to the account and offer this menu shows.
  const hostScope =
    hostSnapshot?.rateLimits && !hostSnapshot.rateLimits.codex?.usageMetadata?.unverifiableOwner
      ? buildActiveCodexResetCreditExpectedScope({
          codex: hostSnapshot.codex,
          rateLimits: hostSnapshot.rateLimits
        })
      : null

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    if (resetBlocked) {
      resetConfirmationRevision.current += 1
      setResetConfirmOpen(false)
      setSkipFutureResetConfirm(false)
    }
  }, [resetBlocked])

  // Why: handlers and the post-write recheck run after commit, so they read the committed offer.
  useLayoutEffect(() => {
    offerAvailableRef.current = offerAvailable
  }, [offerAvailable])

  const confirmedOfferKey = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (confirmedOfferKey.current !== null && confirmedOfferKey.current !== offerKey) {
      confirmedOfferKey.current = null
      resetConfirmationRevision.current += 1
      setResetConfirmOpen(false)
      setSkipFutureResetConfirm(false)
    }
  }, [offerKey])

  useEffect(() => {
    if (!enabled || !menuOpen || !hostEnvironmentId) {
      return
    }
    let live = true
    hostSupportsCodexResetCredit(hostEnvironmentId)
      .then((supported) => {
        if (live) {
          setHostSupport({ environmentId: hostEnvironmentId, supported })
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [enabled, menuOpen, hostEnvironmentId])

  const canRedeemCurrentReset = (): boolean =>
    enabled &&
    offerAvailableRef.current &&
    mountedRef.current &&
    (hostEnvironmentId !== null || useAppStore.getState().rateLimits.codexTarget.runtime === 'host')

  const redeem = async (scope: CodexResetCreditExpectedScope | null): Promise<void> => {
    if (resetBlocked || isRedeemingReset || !canRedeemCurrentReset()) {
      return
    }
    setIsRedeemingReset(true)
    await redeemLoggingFailure(() =>
      hostEnvironmentId
        ? consumeHostCodexResetCredit(hostEnvironmentId, scope)
        : consumeLocalResetCredit()
    )
    if (mountedRef.current) {
      setIsRedeemingReset(false)
    }
  }

  const handleResetMenuSelect = (): void => {
    if (resetBlocked || !canRedeemCurrentReset()) {
      return
    }
    if (
      skipResetConfirm ||
      (hostEnvironmentId !== null && hasUnansweredHostCodexReset(hostEnvironmentId))
    ) {
      void redeem(hostScope)
      return
    }
    // Why: the confirmation names one account; a host switch while it is open must not spend another's credit.
    setConfirmedScope(hostScope)
    confirmedOfferKey.current = offerKey
    setSkipFutureResetConfirm(false)
    setResetConfirmOpen(true)
  }

  const handleConfirmReset = async (): Promise<void> => {
    if (resetBlocked || isRedeemingReset || !canRedeemCurrentReset()) {
      return
    }
    const revision = resetConfirmationRevision.current
    if (skipFutureResetConfirm) {
      try {
        await updateSettings({ skipCodexRateLimitResetConfirm: true })
      } catch (error) {
        console.error('Failed to save Codex reset confirmation preference:', error)
      }
    }
    // Why: the offer can change or run out while the preference write is in flight.
    if (revision !== resetConfirmationRevision.current || !canRedeemCurrentReset()) {
      return
    }
    await redeem(confirmedScope)
    if (mountedRef.current) {
      setResetConfirmOpen(false)
      setSkipFutureResetConfirm(false)
    }
  }

  const redeemable = hostEnvironmentId
    ? hostScope !== null &&
      hostSupport?.environmentId === hostEnvironmentId &&
      hostSupport.supported
    : true
  return {
    ...getCodexResetProjection(codex, enabled && redeemable, t),
    /** The host account the open confirmation will spend for, so its label can't drift. */
    confirmedResetAccountId: confirmedScope?.accountId ?? null,
    handleConfirmReset,
    handleResetMenuSelect,
    isRedeemingReset,
    resetConfirmOpen: resetConfirmOpen && !resetBlocked,
    setResetConfirmOpen,
    setSkipFutureResetConfirm,
    skipFutureResetConfirm
  }
}
