import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/identifiers/non-secure-context-uuid'
import React, { useRef, useState } from 'react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { CLAUDE_RESET_CREDIT_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/protocol/account-runtime-capabilities'
import {
  canUseClaudeResetGrant,
  type ClaudeResetAccount,
  type ClaudeResetCreditOffer,
  type ClaudeResetCreditRequest,
  type ClaudeResetCreditResult,
  type ClaudeResetCredits as ResetCredits
} from '../../../../../shared/agent-accounts/claude/claude-reset-credit-types'
import { CodexResetCredits, CodexResetConfirmation } from './CodexResetCredits'
import { formatResetCreditExpiry } from '../usage/provider-usage-panel'

export function ClaudeResetCredits({
  credits: initialCredits,
  account,
  owner,
  disabled = false
}: {
  credits: ResetCredits | null | undefined
  account: ClaudeResetAccount
  owner: RuntimeClientTarget
  disabled?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const skipConfirmation = useAppStore((s) => s.settings?.skipClaudeRateLimitResetConfirm === true)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [skipFutureConfirm, setSkipFutureConfirm] = useState(false)
  const [offer, setOffer] = useState<ClaudeResetCreditOffer | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ClaudeResetCreditResult | null>(null)
  const credits = offer ? offer.credits : initialCredits
  const now = useNow(60_000)
  const remainingGrants =
    credits?.grants.filter(
      (grant) =>
        grant.resetsLeft > 0 &&
        !grant.paused &&
        (grant.startsAt === null || grant.startsAt <= now) &&
        (grant.endsAt === null || grant.endsAt > now)
    ) ?? []
  const count = remainingGrants.reduce((total, grant) => total + grant.resetsLeft, 0)
  const expirations = remainingGrants.flatMap((grant) =>
    grant.endsAt === null ? [] : [grant.endsAt]
  )
  const nextExpiry = expirations.length > 0 ? Math.min(...expirations) : null
  const pending =
    offer?.pendingRequestId != null ||
    result?.outcome === 'unknown' ||
    (result?.outcome === 'reset' && !result.verified)
  const selected = credits?.grants.find((grant) => grant.id === credits.nextGrantId)
  const canRedeem =
    !pending &&
    !disabled &&
    !!credits &&
    !!selected &&
    canUseClaudeResetGrant(credits, selected, now)

  async function redeem(savePreference = false): Promise<void> {
    if (busyRef.current || disabled) {
      return
    }
    busyRef.current = true
    setBusy(true)
    setError(null)
    let submitted: ClaudeResetCreditRequest | null = null
    try {
      if (savePreference) {
        await updateSettings({ skipClaudeRateLimitResetConfirm: true }).catch(() => {
          // The confirmed reset can proceed without saving the preference.
        })
      }
      const params = { account, requestId: result?.requestId }
      const next = await callRuntimeRpc<ClaudeResetCreditOffer>(
        owner,
        'accounts.queryClaudeResetCredits',
        params,
        {
          timeoutMs: 70_000,
          paramsForStatus: (status) => {
            if (status && !status.capabilities?.includes(CLAUDE_RESET_CREDIT_RUNTIME_CAPABILITY)) {
              throw new Error(
                t(
                  'claude.resetCredits.updateHost',
                  'Update Orca on this host to use Claude reset cards.'
                )
              )
            }
            return params
          }
        }
      )
      setOffer(next)
      if (next.previousResult) {
        setResult(next.previousResult)
      }
      const grant = next.credits?.grants.find(
        (candidate) => candidate.id === next.credits?.nextGrantId
      )
      if (!next.pendingRequestId) {
        if (!next.credits || !grant || !canUseClaudeResetGrant(next.credits, grant)) {
          setError(t('claude.resetCredits.notUsable', 'Not available to use right now.'))
        } else {
          submitted = {
            account: next.account,
            identity: next.identity,
            grantId: grant.id,
            expectedResetsLeft: grant.resetsLeft,
            expectedClears: grant.clears,
            requestId: createBrowserUuid()
          }
          const reply = await callRuntimeRpc<ClaudeResetCreditResult>(
            owner,
            'accounts.consumeClaudeResetCredit',
            submitted,
            { timeoutMs: 120_000 }
          )
          setResult(reply)
          setOffer({
            ...next,
            credits: reply.credits,
            pendingRequestId:
              reply.outcome === 'unknown' || (reply.outcome === 'reset' && !reply.verified)
                ? submitted.requestId
                : null
          })
        }
      }
    } catch (cause) {
      if (submitted) {
        setResult({
          requestId: submitted.requestId,
          outcome: 'unknown',
          cleared: [],
          cooldownUntil: null,
          credits: null,
          verified: false
        })
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : t('claude.resetCredits.queryFailed', 'Could not query reset cards.')
        )
      }
    }
    busyRef.current = false
    setBusy(false)
    setConfirmOpen(false)
    setSkipFutureConfirm(false)
  }

  if (!credits && !error && !pending && !result) {
    return null
  }
  return (
    <div className="space-y-2">
      {credits ? (
        <CodexResetCredits
          resetCreditCount={count}
          resetCreditExpiry={formatResetCreditExpiry(nextExpiry, count, t)}
          canRedeemReset={canRedeem}
          isRedeemingReset={busy}
          onReset={() => {
            if (skipConfirmation) {
              void redeem()
            } else {
              setSkipFutureConfirm(false)
              setConfirmOpen(true)
            }
          }}
          renderAction={(action) => (
            <DropdownMenuItem asChild disabled={busy} onSelect={(event) => event.preventDefault()}>
              {action}
            </DropdownMenuItem>
          )}
        />
      ) : null}
      {pending ? (
        <p role="status" className="text-2xs text-muted-foreground">
          {t(
            'claude.resetCredits.pending',
            'The previous reset is awaiting confirmation. Another reset cannot be submitted yet.'
          )}
        </p>
      ) : null}
      {result?.outcome === 'reset' ? (
        <p role="status" className="text-2xs text-muted-foreground">
          {result.verified
            ? t('claude.resetCredits.success', 'Reset completed. Remaining uses verified.')
            : t(
                'claude.resetCredits.unverified',
                'Claude reported a reset. The remaining uses could not be verified yet.'
              )}
        </p>
      ) : null}
      {result && result.outcome !== 'reset' && result.outcome !== 'unknown' ? (
        <p role="status" className="text-2xs text-muted-foreground">
          {t('claude.resetCredits.refused', 'Claude did not reset the limits: {{reason}}', {
            reason: result.outcome
          })}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : null}
      <CodexResetConfirmation
        provider="claude"
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        skipFutureResetConfirm={skipFutureConfirm}
        onSkipChange={setSkipFutureConfirm}
        isRedeemingReset={busy}
        onConfirm={() => redeem(skipFutureConfirm)}
      />
    </div>
  )
}
