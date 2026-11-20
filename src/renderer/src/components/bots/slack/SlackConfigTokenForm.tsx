import React, { useId, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

// Where Slack lists "Your App Configuration Tokens".
const SLACK_APPS_URL = 'https://api.slack.com/apps'

/** Paste a workspace's configuration refresh token; it is cleared the moment it is sent. Slack's
 *  page opens on the host, so the token is made with that computer's own Slack login. */
export function SlackConfigTokenForm({
  hostId,
  submitLabel,
  busy,
  error,
  onSubmit,
  aside
}: {
  hostId: ExecutionHostId
  submitLabel: string
  busy: boolean
  error: string | null
  onSubmit: (token: string) => void
  /** A quiet line above the steps, such as another way to get the app. */
  aside?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const [token, setToken] = useState('')
  const trimmed = token.trim()

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed || busy) {
          return
        }
        setToken('')
        onSubmit(trimmed)
      }}
    >
      {aside}
      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={() => openBotHostPageOrSay(hostId, SLACK_APPS_URL, { local: 'system' })}
      >
        {t('bots.slack.token.open', 'Get config token')}
        <ExternalLink />
      </Button>
      <ol className="list-decimal space-y-1.5 pl-5 text-sm">
        <li>
          {t(
            'bots.slack.token.step1',
            'In Slack app settings, find “Your App Configuration Tokens” and choose Generate Token.'
          )}
        </li>
        <li>{t('bots.slack.token.step2', 'Select the workspace for your bot.')}</li>
        <li>{t('bots.slack.token.step3', 'Copy the Refresh Token and paste it below.')}</li>
      </ol>
      <p className="text-sm text-muted-foreground">
        {t(
          'bots.slack.token.kept',
          'Orca Cloud keeps this token encrypted, so your next bots in this workspace need one click.'
        )}
      </p>
      <div className="space-y-1.5">
        <Label htmlFor={inputId}>
          {t('bots.slack.token.label', 'Configuration refresh token')}
        </Label>
        <Input
          id={inputId}
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={token}
          aria-invalid={error !== null}
          onChange={(event) => setToken(event.target.value)}
        />
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
      <DialogFooter>
        <Button type="submit" disabled={busy || !trimmed}>
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
