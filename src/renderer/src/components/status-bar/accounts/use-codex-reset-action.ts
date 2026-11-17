import { useEffect, useRef, useState } from 'react'
import type { ProviderRateLimits } from '../../../../../shared/agent-usage/rate-limits/rate-limit-types'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import {
  buildActiveCodexResetCreditExpectedScope,
  type CodexResetCreditExpectedScope
} from '../../../../../shared/agent-accounts/codex/codex-reset-credit-scope'
import type { ProviderAccountsSnapshot } from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  consumeHostCodexResetCredit,
  hostSupportsCodexResetCredit
} from '@/runtime/provider-accounts/usage/runtime-codex-reset-credit-client'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '../../../store/index'
import { getCodexResetProjection } from './codex-switcher-projection'

type HostResetAttempt = {
  environmentId: string
  idempotencyKey: string
  expectedScope: CodexResetCreditExpectedScope
}

/** The status bar's Codex reset: this desktop's login locally, the owning host's account remotely. */
export function useCodexResetAction(
  codex: ProviderRateLimits,
  hostEnvironmentId: string | null,
  hostSnapshot: ProviderAccountsSnapshot | null,
  menuOpen: boolean
) {
  const t = useTranslate()
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false)
  const [skipFutureResetConfirm, setSkipFutureResetConfirm] = useState(false)
  const [isRedeemingReset, setIsRedeemingReset] = useState(false)
  const [hostSupport, setHostSupport] = useState<{
    environmentId: string
    supported: boolean
  } | null>(null)
  const hostAttemptRef = useRef<HostResetAttempt | null>(null)
  const mountedRef = useRef(true)
  const skipResetConfirm = useAppStore((s) => s.settings?.skipCodexRateLimitResetConfirm === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const consumeLocalResetCredit = useAppStore((s) => s.consumeCodexRateLimitResetCredit)

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

  useEffect(() => {
    if (!menuOpen || !hostEnvironmentId) {
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
  }, [menuOpen, hostEnvironmentId])

  const redeemOnHost = async (environmentId: string): Promise<void> => {
    if (!hostScope) {
      return
    }
    const previous = hostAttemptRef.current
    // Why: a retry after a lost reply reuses its key so the host's ledger never spends twice.
    const attempt =
      previous?.environmentId === environmentId &&
      JSON.stringify(previous.expectedScope) === JSON.stringify(hostScope)
        ? previous
        : { environmentId, idempotencyKey: createBrowserUuid(), expectedScope: hostScope }
    hostAttemptRef.current = attempt
    await consumeHostCodexResetCredit(environmentId, {
      idempotencyKey: attempt.idempotencyKey,
      expectedScope: attempt.expectedScope
    })
    hostAttemptRef.current = null
  }

  const redeem = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    setIsRedeemingReset(true)
    try {
      await (hostEnvironmentId ? redeemOnHost(hostEnvironmentId) : consumeLocalResetCredit())
    } catch (error) {
      console.error('Failed to redeem Codex rate-limit reset from status bar:', error)
    } finally {
      if (mountedRef.current) {
        setIsRedeemingReset(false)
      }
    }
  }

  const handleResetMenuSelect = (): void => {
    if (skipResetConfirm) {
      void redeem()
      return
    }
    setSkipFutureResetConfirm(false)
    setResetConfirmOpen(true)
  }

  const handleConfirmReset = async (): Promise<void> => {
    if (isRedeemingReset) {
      return
    }
    if (skipFutureResetConfirm) {
      try {
        await updateSettings({ skipCodexRateLimitResetConfirm: true })
      } catch (error) {
        console.error('Failed to save Codex reset confirmation preference:', error)
      }
    }
    await redeem()
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
    ...getCodexResetProjection(codex, redeemable, t),
    handleConfirmReset,
    handleResetMenuSelect,
    isRedeemingReset,
    resetConfirmOpen,
    setResetConfirmOpen,
    setSkipFutureResetConfirm,
    skipFutureResetConfirm
  }
}
