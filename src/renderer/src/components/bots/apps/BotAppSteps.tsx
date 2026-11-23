// The steps after Add that are neither Orca's own connector setups nor an app by URL: Webhooks (set up
// in chat) and the one-time Composio account.
import type { BotOnHost } from '@/lib/bot-hosts'
import React, { useId, useState } from 'react'
import { ExternalLink, MessageCircle, Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { COMPOSIO_PAGES } from '../../../../../shared/composio/composio-apps'
import { botToolErrorMessage } from '../bot-tools-client'
import { openComposioPage, saveComposioKey } from '../composio/composio-client'
import { BotAppLogo } from './BotAppRow'
import { useBotHostLabel } from '../use-bot-host-label'
import { BotAppStepHeader, BotAppStepHeading } from './BotAppStepParts'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'

const FORM_BODY = 'px-6 pt-1 pb-6'

export function DingTalkSetupDialog({
  bot,
  open,
  onOpenChange
}: {
  bot: Bot
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('bots.dingtalk.connect', 'Connect DingTalk')}</DialogTitle>
          <DialogDescription>
            {t(
              'bots.dingtalk.description',
              'Use the local DingTalk connector to let {{bot}} receive selected group messages on this computer.',
              { bot: bot.name }
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-start gap-3 rounded-lg border border-border p-3 text-sm">
          <MessageCircle className="mt-0.5 size-5 shrink-0" />
          <p className="text-muted-foreground">
            {t(
              'bots.dingtalk.localOnly',
              'The connector runs locally and uses your existing dws login. Add each group to dingtalk-local.json in the Orca profile data directory, set its botId to {{botId}}, then restart Orca.',
              { botId: bot.id }
            )}
          </p>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>{t('common.done', 'Done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function WebhooksStep({
  bot,
  onBack,
  onClose,
  onSetUp
}: {
  bot: Bot
  onBack: () => void
  onClose: () => void
  onSetUp: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <BotAppStepHeader onBack={onBack} onClose={onClose} />
      <div className={FORM_BODY}>
        <BotAppStepHeading
          logo={<BotAppLogo icon={<Webhook className="size-6.5" />} size="lg" />}
          title={t('bots.apps.webhooks.title', 'Add Webhooks')}
          line={t('bots.apps.webhooks.line', 'Events from any tool or script')}
        />
        <p className="text-sm">
          {t(
            'bots.apps.webhooks.how',
            '{{bot}} sets this up with you in chat: it asks what should start it, then gives you the address to call.',
            { bot: bot.name }
          )}
        </p>
        <div className="mt-5 flex justify-end">
          <Button size="sm" onClick={onSetUp}>
            {t('bots.connectors.setUpInChat', 'Set up in chat')}
          </Button>
        </div>
      </div>
    </>
  )
}

/** The owner's Composio key, once for all bots; then the app's sign-in, or the full catalog. */
export function ComposioAccountStep({
  bot,
  appName,
  onBack,
  onClose,
  onSaved
}: {
  bot: BotOnHost
  /** The app picked, or none when Browse all asked for the account. */
  appName?: string
  onBack: () => void
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const host = useBotHostLabel(bot.hostId)
  const inputId = useId()
  const errorId = useId()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = key.trim()
  return (
    <>
      <BotAppStepHeader onBack={onBack} onClose={onClose} />
      <form
        className={FORM_BODY}
        onSubmit={(event) => {
          event.preventDefault()
          if (!trimmed || busy) {
            return
          }
          setBusy(true)
          setError(null)
          void saveComposioKey(trimmed, { hostId: bot.hostId })
            .then(onSaved)
            .catch((caught: unknown) => {
              setError(botToolErrorMessage(caught))
              setBusy(false)
            })
        }}
      >
        <BotAppStepHeading
          logo={<BotAppLogo slug="composio" size="lg" />}
          title={t('bots.apps.composio.accountTitle', 'Connect your Composio account')}
          line={
            appName
              ? t(
                  'bots.apps.composio.accountThenApp',
                  'Once, for all your bots. Then you sign in to {{app}} on Composio’s page.',
                  { app: appName }
                )
              : t(
                  'bots.apps.composio.accountThenCatalog',
                  'Once, for all your bots. Then pick from all of Composio’s apps.'
                )
          }
        />
        <div className="mb-1.5 flex items-center">
          <Label htmlFor={inputId}>{t('bots.composio.key.label', 'Composio API key')}</Label>
          <span className="flex-1" />
          <Button
            type="button"
            variant="link"
            size="inlineText"
            onClick={() => openComposioPage(COMPOSIO_PAGES.apiKeys)}
          >
            {t('bots.composio.key.getKey', 'Get a key')}
            <ExternalLink />
          </Button>
        </div>
        <Input
          id={inputId}
          type="password"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder={t('bots.composio.key.placeholder', 'Paste your key')}
          value={key}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setKey(event.target.value)}
        />
        {error ? (
          <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <p className="mt-1.5 text-xs text-muted-foreground">
          {host
            ? t(
                'bots.apps.composio.keyStoredOnHost',
                'Stored on {{host}}; bots never see it. Composio holds your app sign-ins.',
                { host }
              )
            : t(
                'bots.apps.composio.keyStored',
                'Stored on this computer; bots never see it. Composio holds your app sign-ins.'
              )}
        </p>
        <div className="mt-5 flex justify-end">
          <Button type="submit" size="sm" disabled={busy || !trimmed}>
            {busy
              ? t('bots.composio.key.checking', 'Checking…')
              : t('bots.apps.composio.addKey', 'Add key and continue')}
          </Button>
        </div>
      </form>
    </>
  )
}
