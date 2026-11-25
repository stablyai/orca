import React, { useState } from 'react'
import { toast } from 'sonner'
import { FeishuIcon } from '../../icons/FeishuIcon'
import { BotAppBrandLogo } from '../apps/BotAppBrandLogo'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { FeishuLocalState } from '../../../../../shared/bots/feishu-local'
import { BotConnectorRowFrame } from '../BotConnectorRow'
import { botErrorMessage } from '../bot-presentation'
import { openBotSession } from '../bot-session-open'
import { BotFeishuSetup } from './BotFeishuSetup'
import { feishuCall } from './feishu-local-client'

function FeishuReview({
  bot,
  review
}: {
  bot: Bot
  review: NonNullable<FeishuLocalState['review']>
}): React.JSX.Element {
  const t = useTranslate()
  const [busy, setBusy] = useState(false)
  const act = (method: 'retryReview' | 'dismissReview'): void => {
    setBusy(true)
    void feishuCall(bot, method)
      .catch((error: unknown) => toast.error(botErrorMessage(error)))
      .finally(() => setBusy(false))
  }
  const unknown = review.count - review.retryable
  return (
    <div className="space-y-2 rounded-md border border-border p-2" role="status">
      {review.retryable > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.feishu.reviewRetryable',
            '{{count}} Feishu messages didn’t reach a chat. Retry sends them again; Dismiss drops them.',
            {
              count: review.retryable,
              defaultValue_one:
                'A Feishu message didn’t reach a chat. Retry sends it again; Dismiss drops it.'
            }
          )}
        </p>
      ) : null}
      {unknown > 0 ? (
        <p className="text-xs text-muted-foreground">
          {t(
            'bots.feishu.reviewUnknown',
            '{{count}} Feishu messages may not have been answered. Check the DM and the chat, then dismiss.',
            {
              count: unknown,
              defaultValue_one:
                'A Feishu message may not have been answered. Check the DM and the chat, then dismiss.'
            }
          )}
        </p>
      ) : null}
      <div className="flex gap-2">
        {review.retryable > 0 ? (
          <Button size="sm" disabled={busy} onClick={() => act('retryReview')}>
            {t('bots.feishu.retry', 'Retry')}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => act('dismissReview')}>
          {t('bots.feishu.dismiss', 'Dismiss')}
        </Button>
      </div>
    </div>
  )
}

export function BotFeishuCard({
  bot,
  state
}: {
  bot: Bot
  state: FeishuLocalState
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const fallback = state.streaming?.mode === 'fallback'
  const missing = state.streaming?.missing?.join(', ')
  return (
    <BotConnectorRowFrame
      icon={<FeishuIcon className="size-4" />}
      logo={<BotAppBrandLogo app={{ id: 'feishu-local' }} />}
      name={t('bots.feishu.name', 'Feishu')}
      description={t('bots.feishu.line', 'Private messages through Feishu CLI on this host')}
      status={
        state.review || fallback
          ? { label: t('bots.feishu.needsLook', 'Needs a look'), tone: 'attention' }
          : null
      }
    >
      <p className="text-xs text-muted-foreground">{state.profile}</p>
      {state.streaming ? (
        <p className="text-xs text-muted-foreground">
          {!fallback
            ? t(
                'bots.feishu.streamingCards',
                'Replies show Orca’s steps and answer in one Feishu card as it works.'
              )
            : missing
              ? t(
                  'bots.feishu.streamingMissing',
                  'Live replies are off: the app lacks {{scopes}}. Feishu gets a notice, then the final answer. Grant it and publish a new app version.',
                  { scopes: missing }
                )
              : t(
                  'bots.feishu.streamingDenied',
                  'Live replies are off: Feishu says the app lacks a permission. Feishu gets a notice, then the final answer.'
                )}
        </p>
      ) : null}
      {state.review ? <FeishuReview bot={bot} review={state.review} /> : null}
      <div className="flex flex-wrap gap-2">
        {state.chat ? (
          <Button size="sm" onClick={() => openBotSession(bot, state.chat!.sessionId)}>
            {t('bots.feishu.openConversation', 'Open conversation')}
          </Button>
        ) : null}
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          {t('bots.feishu.settings', 'Connection settings')}
        </Button>
      </div>
      {open ? <BotFeishuSetup bot={bot} onClose={() => setOpen(false)} /> : null}
    </BotConnectorRowFrame>
  )
}
