import { createBrowserUuid } from '@/lib/browser-uuid'
import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type {
  AgentSessionAccountUsage,
  AgentSessionUsageAccount
} from '../../../../shared/agent-session/agent-session-account-usage'
import type { CodexRateLimitResetOutcome } from '../../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { ProviderIdentityCard } from '../status-bar/ProviderIdentityCard'
import { CodexResetConfirmation, CodexResetCredits } from '../status-bar/CodexResetCredits'
import { formatResetCreditExpiry } from '../status-bar/tooltip'

type UsageResult = Extract<AgentSessionAccountUsage, { status: 'ok' }>

function resetOutcomeNotice(outcome: CodexRateLimitResetOutcome): string {
  switch (outcome) {
    case 'reset':
      return translate('components.native-chat.usage.outcome.reset', 'Codex limits were reset.')
    case 'nothingToReset':
      return translate(
        'components.native-chat.usage.outcome.nothingToReset',
        'Nothing to reset right now.'
      )
    case 'noCredit':
      return translate(
        'components.native-chat.usage.outcome.noCredit',
        'No Codex reset credit is left on this account.'
      )
    case 'alreadyRedeemed':
      return translate(
        'components.native-chat.usage.outcome.alreadyRedeemed',
        'That reset credit was already used.'
      )
  }
}

function chatAccountLabel(account: AgentSessionUsageAccount): string {
  switch (account.kind) {
    case 'system':
      return translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')
    case 'managed':
      return (
        account.email || translate('auto.lib.codex.session.restart.9f0b1c2d3e', 'Codex account')
      )
    case 'shared':
      return (
        account.email ||
        translate('components.native-chat.usage.sharedAccount', 'Current shared account')
      )
  }
}

export function NativeChatAccountUsageCard({
  result,
  notice,
  target,
  onRetry
}: {
  result: AgentSessionAccountUsage | null
  notice: string | null
  target: RuntimeClientTarget
  onRetry: (notice?: string | null) => void
}): React.JSX.Element {
  const display = normalizeUsagePercentageDisplay(useAppStore((s) => s.usagePercentageDisplay))
  const message =
    result === null
      ? translate('components.native-chat.usage.loading', 'Loading Codex usage…')
      : result.status === 'failed'
        ? translate(
            'components.native-chat.usage.failed',
            'Codex usage couldn’t be loaded. Try again.'
          )
        : result.status === 'unsupported'
          ? result.reason === 'codexVersion'
            ? translate(
                'components.native-chat.usage.codexVersion',
                'This Codex version doesn’t report usage. Update Codex.'
              )
            : translate(
                'components.native-chat.usage.apiKeyAuth',
                'Codex usage isn’t available with an API key. Sign in to Codex with a ChatGPT account to view usage.'
              )
          : null
  return (
    <div className="p-3 text-sm text-foreground">
      {result?.status === 'ok' ? (
        <>
          <div className="mb-2 text-xs text-muted-foreground">
            {translate('components.native-chat.usage.account', 'Account used by this chat')}
          </div>
          <ProviderIdentityCard
            p={result.rateLimits}
            accountLabel={chatAccountLabel(result.account)}
            usagePercentageDisplay={display}
            footer={<ChatUsageReset result={result} target={target} onRefresh={onRetry} />}
          />
        </>
      ) : (
        <div className="flex items-center gap-2">
          {result === null ? <Loader2 className="size-4 animate-spin" /> : null}
          {message}
          {result?.status === 'failed' ? (
            <Button variant="outline" size="xs" onClick={() => onRetry(notice)}>
              {translate('components.native-chat.usage.retry', 'Retry')}
            </Button>
          ) : null}
        </div>
      )}
      {/* A reset's outcome outlives the refresh it triggered, whether that refresh succeeds or not. */}
      {notice ? <div className="mt-2 text-xs text-muted-foreground">{notice}</div> : null}
    </div>
  )
}

function ChatUsageReset({
  result,
  target,
  onRefresh
}: {
  result: UsageResult
  target: RuntimeClientTarget
  onRefresh: (notice: string | null) => void
}): React.JSX.Element | null {
  const [confirm, setConfirm] = useState(false)
  const [skip, setSkip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const attempt = useRef<{
    idempotencyKey: string
    expectedScope: NonNullable<UsageResult['reset']>['expectedScope']
  } | null>(null)
  const skipConfirm = useAppStore((s) => s.settings?.skipCodexRateLimitResetConfirm === true)
  const credits = result.rateLimits.rateLimitResetCredits
  const count = result.reset?.available ?? credits?.availableCount
  if (count === undefined) {
    return null
  }
  const redeem = async (): Promise<void> => {
    if (busy || !result.reset) {
      return
    }
    attempt.current ??= {
      idempotencyKey: createBrowserUuid(),
      expectedScope: result.reset.expectedScope
    }
    setBusy(true)
    setFailed(false)
    setConfirm(false)
    try {
      const reply = await callRuntimeRpc<{ outcome?: CodexRateLimitResetOutcome }>(
        target,
        'accounts.consumeCodexResetCredit',
        attempt.current
      )
      attempt.current = null
      // A changed offer carries no outcome: the refreshed card shows the current offer.
      onRefresh(reply?.outcome ? resetOutcomeNotice(reply.outcome) : null)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <CodexResetCredits
        resetCreditCount={count}
        resetCreditExpiry={formatResetCreditExpiry(
          result.reset?.expiresAt ?? credits?.nextExpiresAt,
          count
        )}
        canRedeemReset={result.reset !== undefined}
        isRedeemingReset={busy}
        onReset={() => {
          if (skipConfirm || attempt.current) {
            void redeem()
          } else {
            setSkip(false)
            setConfirm(true)
          }
        }}
      />
      {failed ? (
        <div className="mt-2 flex items-center gap-2 text-xs">
          {translate(
            'components.native-chat.usage.resetFailed',
            'Codex limits couldn’t be reset. Try again.'
          )}
          <Button variant="outline" size="xs" onClick={() => void redeem()} disabled={busy}>
            {translate('components.native-chat.usage.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      <CodexResetConfirmation
        open={confirm}
        onOpenChange={setConfirm}
        accountLabel={chatAccountLabel(result.account)}
        skipFutureResetConfirm={skip}
        onSkipChange={setSkip}
        isRedeemingReset={busy}
        onConfirm={async () => {
          if (skip) {
            try {
              await useAppStore.getState().updateSettings({ skipCodexRateLimitResetConfirm: true })
            } catch {
              /* The confirmed reset can proceed without saving this preference. */
            }
          }
          await redeem()
        }}
      />
    </>
  )
}
