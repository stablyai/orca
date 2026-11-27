// "I'll do it in Composio": the steps to point the project at its Orca events hook by hand, each
// with its button, then Done, which checks the address, turns the trigger on and saves Composio's
// own secret on the hook.
import React from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botTarget, type BotOnHost } from '@/lib/bot-hosts'
import { COMPOSIO_PAGES } from '../../../../../shared/composio/composio-apps'
import { WebhookCopyUrlButton } from '../webhooks/WebhookCopyUrlButton'
import { openComposioPage } from './composio-client'

export function ComposioEventsByHandStepsView({
  botName,
  triggerName,
  copyUrl,
  busy,
  onDone
}: {
  botName: string
  triggerName: string
  copyUrl: React.ReactNode
  busy: boolean
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const steps = [
    {
      text: t('bots.composio.byHand.copy', 'Copy {{bot}}’s address.', { bot: botName }),
      action: copyUrl
    },
    {
      text: t(
        'bots.composio.byHand.paste',
        'In Composio, open your project’s settings, then Webhooks, and paste it.'
      ),
      action: (
        <Button
          size="xs"
          variant="outline"
          onClick={() => openComposioPage(COMPOSIO_PAGES.settings)}
        >
          {t('bots.composio.byHand.open', 'Open Composio')}
          <ExternalLink />
        </Button>
      )
    }
  ]
  return (
    <>
      <ol className="mt-1.5 flex flex-col gap-1.5">
        {steps.map((step, index) => (
          <li key={step.text} className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-3 shrink-0 tabular-nums">{index + 1}.</span>
            <span className="min-w-0 flex-1">{step.text}</span>
            {step.action}
          </li>
        ))}
      </ol>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="xs" disabled={busy} onClick={onDone}>
          {t('bots.composio.byHand.done', 'Done')}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t(
            'bots.composio.byHand.doneNote',
            'Orca then turns on {{trigger}} and saves Composio’s signing secret.',
            { trigger: triggerName }
          )}
        </span>
      </div>
    </>
  )
}

export function ComposioEventsByHandSteps({
  bot,
  hookId,
  botName,
  triggerName,
  busy,
  onDone
}: {
  bot: BotOnHost
  /** The project's events hook, not the card's own. */
  hookId: string
  botName: string
  triggerName: string
  busy: boolean
  onDone: () => void
}): React.JSX.Element {
  return (
    <ComposioEventsByHandStepsView
      botName={botName}
      triggerName={triggerName}
      copyUrl={<WebhookCopyUrlButton target={botTarget(bot)} hookId={hookId} botName={botName} />}
      busy={busy}
      onDone={onDone}
    />
  )
}
