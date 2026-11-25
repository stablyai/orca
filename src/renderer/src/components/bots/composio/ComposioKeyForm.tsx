// The owner's Composio key, pasted in place wherever Orca asks for it (a bot's Tools, its chat's key
// card, Settings), straight to the bots' host; bots never see it. Saving checks it with Composio first.
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import React, { useId, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import { botToolErrorMessage } from '../bot-tools-client'
import { COMPOSIO_PAGES } from '../../../../../shared/composio/composio-apps'
import type { ComposioSetupApp } from '../../../../../shared/composio/composio-setup-card'
import { openComposioPage, saveComposioKey } from './composio-client'
import { useBotHostLabel } from '../use-bot-host-label'

export function ComposioKeyForm({
  hostId,
  from,
  replacing,
  onSaved,
  onCancel
}: {
  /** The computer whose key this is. */
  hostId: ExecutionHostId
  /** A setup card's form: its bot's chat moves on once the key is saved. */
  from?: { botId: string; app?: ComposioSetupApp }
  /** Change key or Replace key, rather than the first one. */
  replacing?: boolean
  onSaved?: () => void
  onCancel?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const host = useBotHostLabel(hostId)
  const inputId = useId()
  const errorId = useId()
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const trimmed = key.trim()
  const label = t('bots.composio.key.label', 'Composio API key')
  return (
    <form
      className="flex flex-col gap-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed || busy) {
          return
        }
        setBusy(true)
        setError(null)
        void saveComposioKey(trimmed, { hostId, ...from })
          .then(() => {
            setKey('')
            onSaved?.()
          })
          .catch((caught: unknown) => setError(botToolErrorMessage(caught)))
          .finally(() => setBusy(false))
      }}
    >
      <p className="text-xs text-muted-foreground">
        {host
          ? t(
              'bots.composio.key.purposeOnHost',
              'Your Composio project key lets the bots on {{host}} use the apps you connect there. It stays on {{host}}; bots never see it.',
              { host }
            )
          : t(
              'bots.composio.key.purpose',
              'Your Composio project key lets your bots use the apps you connect there. It stays on this computer; bots never see it.'
            )}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          aria-label={label}
          placeholder={t('bots.composio.key.placeholder', 'Paste your key')}
          value={key}
          aria-invalid={error !== null}
          aria-describedby={error ? errorId : undefined}
          onChange={(event) => setKey(event.target.value)}
          className="h-7 min-w-0 flex-1 basis-48"
        />
        <Button type="submit" size="xs" disabled={busy || !trimmed}>
          {busy
            ? t('bots.composio.key.checking', 'Checking…')
            : replacing
              ? t('bots.composio.key.replace', 'Replace key')
              : t('bots.composio.key.add', 'Add key')}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => openComposioPage(COMPOSIO_PAGES.apiKeys)}
        >
          {t('bots.composio.key.getKey', 'Get a key')}
          <ExternalLink />
        </Button>
        {onCancel ? (
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onCancel}>
            {t('bots.composio.key.cancel', 'Cancel')}
          </Button>
        ) : null}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </form>
  )
}
