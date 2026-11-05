import { createBrowserUuid } from '@/lib/browser-uuid'
import { useRef, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type { AgentSessionAccountUsage } from '../../../../shared/agent-session/agent-session-account-usage'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { normalizeUsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import { ProviderIdentityCard } from '../status-bar/ProviderIdentityCard'
import { CodexResetConfirmation, CodexResetCredits } from '../status-bar/CodexResetCredits'
import { formatResetCreditExpiry } from '../status-bar/tooltip'

type UsageResult = Extract<AgentSessionAccountUsage, { status: 'ok' }>

function chatAccountLabel(label: string): string {
  return label === 'System default'
    ? translate('auto.components.status.bar.StatusBar.c676918adc', 'System default')
    : label === 'Current shared account'
      ? translate('components.native-chat.usage.sharedAccount', 'Current shared account')
      : label
}

export function NativeChatAccountUsageCard({
  result,
  target,
  onDismiss,
  onRetry
}: {
  result: AgentSessionAccountUsage | null
  target: RuntimeClientTarget
  onDismiss: () => void
  onRetry: () => void
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
    <div className="relative rounded-md border bg-card p-3 text-sm text-foreground">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="absolute right-1 top-1"
        onClick={onDismiss}
        aria-label={translate('components.native-chat.usage.dismiss', 'Dismiss Codex usage')}
      >
        <X className="size-3.5" />
      </Button>
      <div className="pr-5">
        {result?.status === 'ok' ? (
          <>
            <div className="mb-2 text-xs text-muted-foreground">
              {translate('components.native-chat.usage.account', 'Account used by this chat')}
            </div>
            <ProviderIdentityCard
              p={result.rateLimits}
              accountLabel={chatAccountLabel(result.accountLabel)}
              usagePercentageDisplay={display}
              footer={<ChatUsageReset result={result} target={target} onRefresh={onRetry} />}
            />
          </>
        ) : (
          <div className="flex items-center gap-2">
            {result === null ? <Loader2 className="size-4 animate-spin" /> : null}
            {message}
            {result?.status === 'failed' ? (
              <Button variant="outline" size="xs" onClick={onRetry}>
                {translate('components.native-chat.usage.retry', 'Retry')}
              </Button>
            ) : null}
          </div>
        )}
      </div>
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
  onRefresh: () => void
}): React.JSX.Element | null {
  const [confirm, setConfirm] = useState(false)
  const [skip, setSkip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const attempt = useRef<{
    idempotencyKey: string
    expectedScope: NonNullable<UsageResult['reset']>['expectedScope']
  } | null>(null)
  const settings = useAppStore((s) => s.settings)
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
      await callRuntimeRpc(target, 'accounts.consumeCodexResetCredit', attempt.current)
      attempt.current = null
      onRefresh()
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
          if (settings?.skipCodexRateLimitResetConfirm || attempt.current) {
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
        accountLabel={chatAccountLabel(result.accountLabel)}
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
