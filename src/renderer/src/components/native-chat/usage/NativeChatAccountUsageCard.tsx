import { getManagedAccountInlineLabel } from '../../../../../shared/managed-account-display-names'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type {
  AgentSessionAccountUsage,
  AgentSessionUsageAccount
} from '../../../../../shared/agent-session/agent-session-account-usage'
import type { CodexRateLimitResetOutcome } from '../../../../../shared/rate-limit-types'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { normalizeUsagePercentageDisplay } from '../../../../../shared/usage-percentage-display'
import { getProviderDisplayName } from '../../../../../shared/usage-provider-windows'
import { ProviderIdentityCard } from '../../status-bar/ProviderIdentityCard'
import { CodexResetConfirmation, CodexResetCredits } from '../../status-bar/CodexResetCredits'
import { formatResetCreditExpiry, ProviderIcon } from '../../status-bar/tooltip'

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

function chatAccountLabel(account: AgentSessionUsageAccount, t: Translate = translate): string {
  switch (account.kind) {
    case 'system':
      return t('auto.components.status.bar.StatusBar.c676918adc', 'System default')
    case 'managed':
      return account.email
        ? getManagedAccountInlineLabel(account)
        : t('auto.lib.codex.session.restart.9f0b1c2d3e', 'Codex account')
    case 'shared':
      return (
        account.email || t('components.native-chat.usage.sharedAccount', 'Current shared account')
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
  const t = useTranslate()
  const display = normalizeUsagePercentageDisplay(useAppStore((s) => s.usagePercentageDisplay))
  const message =
    result === null
      ? null
      : result.status === 'failed'
        ? t('components.native-chat.usage.failed', 'Codex usage couldn’t be loaded. Try again.')
        : result.status === 'unsupported'
          ? result.reason === 'codexVersion'
            ? t(
                'components.native-chat.usage.codexVersion',
                'This Codex version doesn’t report usage. Update Codex.'
              )
            : t(
                'components.native-chat.usage.apiKeyAuth',
                'Codex usage isn’t available with an API key. Sign in to Codex with a ChatGPT account to view usage.'
              )
          : null
  const accountHeading = (
    <div className="mb-2 text-xs text-muted-foreground">
      {t('components.native-chat.usage.account', 'Account used by this chat')}
    </div>
  )
  return (
    <div className="p-3 text-sm text-foreground">
      {result === null ? (
        <>
          {accountHeading}
          <LoadingUsageCard />
        </>
      ) : result.status === 'ok' ? (
        <>
          {accountHeading}
          <ProviderIdentityCard
            p={result.rateLimits}
            accountLabel={chatAccountLabel(result.account, t)}
            usagePercentageDisplay={display}
            footer={<ChatUsageReset result={result} target={target} onRefresh={onRetry} />}
          />
        </>
      ) : (
        <div className="flex items-center gap-2">
          {message}
          {result?.status === 'failed' ? (
            <Button variant="outline" size="xs" onClick={() => onRetry(notice)}>
              {t('components.native-chat.usage.retry', 'Retry')}
            </Button>
          ) : null}
        </div>
      )}
      {/* A reset's outcome outlives the refresh it triggered, whether that refresh succeeds or not. */}
      {notice ? <div className="mt-2 text-xs text-muted-foreground">{notice}</div> : null}
    </div>
  )
}

/** The loaded card's layout with one usage window, so loading shows roughly the loaded size. */
function LoadingUsageCard(): React.JSX.Element {
  const t = useTranslate()
  const line = 'block rounded bg-foreground/10'
  return (
    <div className="w-full space-y-2 text-xs" aria-busy="true">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <ProviderIcon provider="codex" />
          {getProviderDisplayName('codex')}
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t('components.native-chat.usage.loading', 'Loading Codex usage…')}
        </span>
      </div>
      <Card size="sm">
        <div className="space-y-3 px-2.5">
          <div className="text-sm">
            <span className={`${line} h-5 w-40`} />
          </div>
          <div className="space-y-1">
            <span className={`${line} h-4 w-14`} />
            <div className="h-[6px] w-full rounded-full bg-foreground/10" />
            <span className={`${line} h-4 w-16`} />
          </div>
          <span className={`${line} h-4 w-36`} />
        </div>
      </Card>
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
  const t = useTranslate()
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
    if (attempt.current == null) {
      attempt.current = {
        idempotencyKey: createBrowserUuid(),
        expectedScope: result.reset.expectedScope
      }
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
          count,
          t
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
          {t(
            'components.native-chat.usage.resetFailed',
            'Codex limits couldn’t be reset. Try again.'
          )}
          <Button variant="outline" size="xs" onClick={() => void redeem()} disabled={busy}>
            {t('components.native-chat.usage.retry', 'Retry')}
          </Button>
        </div>
      ) : null}
      <CodexResetConfirmation
        open={confirm}
        onOpenChange={setConfirm}
        accountLabel={chatAccountLabel(result.account, t)}
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
