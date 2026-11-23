// A webhook automation's setup card in its chat: Copy URL up front, key, secret and sample call one
// link away. Drawn in place of the saved row, so the URL is never folded away.
import React, { useId, useState } from 'react'
import { ChevronRight, Webhook } from 'lucide-react'
import { GoogleSetupReceipt } from '@/components/bots/google/setup-cards/GoogleSetupCardParts'
import { useWebhookActions } from '@/components/bots/webhooks/use-webhook-actions'
import {
  usePendingWebhookSummary,
  WEBHOOK_AGO_TICK_MS
} from '@/components/bots/webhooks/use-webhook-data'
import { useWebhookKeyScope } from '@/components/bots/webhooks/use-webhook-key'
import {
  webhookHostState,
  webhookStateStatus,
  webhookStatus
} from '@/components/bots/webhooks/webhook-copy'
import type { WebhookErrorCode } from '@/components/bots/webhooks/webhook-host-client'
import { WebhookField, WebhookKeyFields } from '@/components/bots/webhooks/webhook-key-fields'
import { WebhookCopyUrlButton } from '@/components/bots/webhooks/WebhookCopyUrlButton'
import { WebhookSecretDialog } from '@/components/bots/webhooks/WebhookSecretDialog'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useNow } from '@/lib/window-activity/use-now'
import { webhookAdapterName } from '../../../../../shared/bots/webhook-card-view'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { WebhookSummary } from '../../../../../shared/rpc-contract/webhooks-params'
import {
  NativeChatCardAvatar,
  NativeChatCardFrame,
  NativeChatCardStatus
} from '../NativeChatCardFrame'

// Hooks whose URL was copied here this session, so the receipt survives the row scrolling away.
const copiedHooks = new Set<string>()

export function NativeChatWebhookSetupCard({
  target,
  hookId,
  botName,
  name
}: {
  target: RuntimeClientTarget
  hookId: string
  botName: string
  /** The automation's name. */
  name: string
}): React.JSX.Element {
  const t = useTranslate()
  const read = usePendingWebhookSummary(target, hookId)
  const summary = read.status === 'ready' ? read.value : null
  const called = summary?.state === 'live' && summary.lastCall !== null
  // "Last call 2 min ago" moves on only once there is a call.
  const now = useNow(WEBHOOK_AGO_TICK_MS, called)
  const [copied, setCopied] = useState(() => copiedHooks.has(hookId))
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const pending = read.status === 'loading' || summary?.state === 'pending'
  const state = summary && summary.state !== 'live' ? webhookStateStatus(summary) : null
  return (
    <div>
      <NativeChatCardFrame
        label={name}
        avatar={
          <NativeChatCardAvatar>
            <Webhook className="size-4" aria-hidden />
          </NativeChatCardAvatar>
        }
        heading={t('components.native-chat.webhookSetup.heading', 'Set up a webhook')}
        status={
          called ? (
            <NativeChatCardStatus tone="success">
              {webhookStateStatus(summary).label}
            </NativeChatCardStatus>
          ) : state ? (
            <NativeChatCardStatus tone="muted">{state.label}</NativeChatCardStatus>
          ) : null
        }
      >
        <div className="mt-0.5 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
          {name}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {called
            ? webhookStatus(summary, now).label
            : t(
                'components.native-chat.automationSaved.webhookHint',
                'Point your service at this URL'
              )}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <WebhookCopyUrlButton
            target={target}
            hookId={hookId}
            botName={botName}
            variant={called ? 'outline' : 'default'}
            copied={copied}
            onCopied={() => {
              copiedHooks.add(hookId)
              setCopied(true)
            }}
          />
          {pending ? null : (
            <Button
              variant="link-muted"
              size="inlineText"
              aria-expanded={open}
              aria-controls={panelId}
              onClick={() => setOpen((value) => !value)}
            >
              {t('components.native-chat.webhookSetup.keyAndSecret', 'Key and signing secret')}
              <ChevronRight
                className={cn('size-3 transition-transform', open && 'rotate-90')}
                aria-hidden
              />
            </Button>
          )}
        </div>
        {open && summary ? (
          <div id={panelId} className="mt-2 border-t border-border pt-1">
            <WebhookSetupKeyFields
              target={target}
              summary={summary}
              refreshError={read.status === 'ready' ? read.refreshError : null}
              botName={botName}
            />
          </div>
        ) : null}
      </NativeChatCardFrame>
      {copied ? (
        <GoogleSetupReceipt
          text={t('components.native-chat.webhookSetup.copiedReceipt', '✓ URL copied')}
        />
      ) : null}
    </div>
  )
}

/** Header key, signing secret and sample call: what a sender needs after the URL. */
function WebhookSetupKeyFields({
  target,
  summary,
  refreshError,
  botName
}: {
  target: RuntimeClientTarget
  summary: WebhookSummary
  refreshError: WebhookErrorCode | null
  botName: string
}): React.JSX.Element {
  const t = useTranslate()
  const [secretOpen, setSecretOpen] = useState(false)
  const keyScope = useWebhookKeyScope(target, summary)
  const actions = useWebhookActions(target, summary, botName)
  const host = webhookHostState(summary, refreshError, botName, target)
  return (
    <>
      {host.line ? <p className="pt-1 text-xs text-muted-foreground">{host.line}</p> : null}
      <WebhookKeyFields
        key={keyScope}
        target={target}
        summary={summary}
        botName={botName}
        canReveal={false}
        headerKey
        url={false}
        disabled={!host.ready}
      />
      <WebhookField
        label={t('components.native-chat.webhookSetup.signingSecret', 'Signing secret')}
        actions={
          <Button
            variant="ghost"
            size="xs"
            disabled={!host.ready}
            onClick={() => setSecretOpen(true)}
          >
            {summary.adapter
              ? t('bots.webhooks.checks.change', 'Change…')
              : t('components.native-chat.webhookSetup.addSecret', 'Add…')}
          </Button>
        }
      >
        {summary.adapter
          ? webhookAdapterName(summary.adapter)
          : t('components.native-chat.webhookSetup.noSecret', 'None')}
      </WebhookField>
      <WebhookField
        label={t('components.native-chat.webhookSetup.sampleCall', 'Sample call')}
        actions={
          <Button
            variant="ghost"
            size="xs"
            disabled={!host.ready || actions.busy || summary.state !== 'live'}
            onClick={actions.sendSample}
          >
            {t('components.native-chat.webhookSetup.send', 'Send')}
          </Button>
        }
      >
        {t('components.native-chat.webhookSetup.sampleNote', 'Starts a real run')}
      </WebhookField>
      <WebhookSecretDialog
        target={target}
        summary={summary}
        botName={botName}
        open={secretOpen}
        onOpenChange={setSecretOpen}
      />
    </>
  )
}
