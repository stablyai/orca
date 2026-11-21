import React, { useEffect, useId, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useTranslate } from '@/i18n/use-translate'
import { openBotHostPageOrSay } from '@/lib/bot-host-page'
import { SLACK_CONFIG_REFRESH_TOKEN_PREFIX } from '../../../../../shared/connector-bot-slack-contract'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

// Where Slack lists "Your App Configuration Tokens".
const SLACK_APPS_URL = 'https://api.slack.com/apps'

// Slack shows two tokens side by side; the access token is the one Orca can't keep using.
const SLACK_CONFIG_ACCESS_TOKEN_PREFIX = 'xoxe.xoxp-'
const TOKEN_SHAPE = /^[\w.-]+$/

/** What copied or pasted text is, when it is one of Slack's two configuration tokens. */
export function slackConfigTokenKind(text: string): 'refresh' | 'access' | null {
  const value = text.trim()
  if (!TOKEN_SHAPE.test(value)) {
    return null
  }
  if (value.startsWith(SLACK_CONFIG_ACCESS_TOKEN_PREFIX)) {
    return 'access'
  }
  return value.startsWith(SLACK_CONFIG_REFRESH_TOKEN_PREFIX) ? 'refresh' : null
}

/** Paste a workspace's configuration refresh token; it is cleared the moment it is sent. Slack's
 *  page opens on the host, so the token is made with that computer's own Slack login. */
export function SlackConfigTokenForm({
  hostId,
  submitLabel,
  busy,
  error,
  onSubmit,
  aside,
  compact = false,
  onCancel,
  secondary = false
}: {
  hostId: ExecutionHostId
  submitLabel: string
  busy: boolean
  error: string | null
  onSubmit: (token: string) => void
  /** A quiet line above the steps, such as another way to get the app. */
  aside?: React.ReactNode
  /** Reconnecting a workspace: short steps with Slack's page as a link, the field without its label. */
  compact?: boolean
  /** A Cancel beside the submit button. */
  onCancel?: () => void
  /** Another of the dialog's buttons is its main action. */
  secondary?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const inputId = useId()
  const [token, setToken] = useState('')
  const [accessPasted, setAccessPasted] = useState(false)
  const trimmed = token.trim()
  // Set once Slack's page is opened from here: the token copied there fills the field on the way back.
  const awaitingCopy = useRef(false)
  // Counts clipboard reads, so one still pending when a later one starts, a token is sent, or the
  // form closes, is dropped.
  const reads = useRef(0)
  const send = (value: string): void => {
    awaitingCopy.current = false
    reads.current++
    setAccessPasted(false)
    setToken('')
    onSubmit(value)
  }
  // A token pasted by the user goes straight in; one read off the clipboard only fills the field,
  // so sending it stays the user's own click. The access token gets a pointer to the other.
  const take = (text: string, pasted: boolean): boolean => {
    const kind = busy ? null : slackConfigTokenKind(text)
    if (kind === 'refresh') {
      if (pasted) {
        send(text.trim())
      } else {
        setAccessPasted(false)
        setToken(text.trim())
      }
    } else if (kind === 'access') {
      setToken('')
      setAccessPasted(true)
    }
    return kind !== null
  }

  const openSlack = (): void => {
    awaitingCopy.current =
      openBotHostPageOrSay(hostId, SLACK_APPS_URL, { local: 'system' }) !== 'unrouted'
  }

  useEffect(
    () => () => {
      reads.current++
    },
    []
  )
  useEffect(() => {
    const onFocus = (): void => {
      if (!awaitingCopy.current) {
        return
      }
      // One read per opening of Slack's page, whatever it finds.
      awaitingCopy.current = false
      const read = ++reads.current
      void window.api.ui
        .readClipboardText()
        .then((text) => {
          if (read === reads.current) {
            take(text, false)
          }
        })
        .catch(() => {})
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  })

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (!trimmed || busy) {
          return
        }
        send(trimmed)
      }}
    >
      {aside}
      {compact ? (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>
            <Button type="button" variant="link" size="inline" onClick={openSlack}>
              {t('bots.slack.token.openSettings', 'Open Slack app settings')}
              <ExternalLink />
            </Button>
          </li>
          <li>{t('bots.slack.token.generate', 'Generate a token for this workspace')}</li>
          <li>{t('bots.slack.token.copyRefresh', 'Copy the Refresh Token')}</li>
        </ol>
      ) : (
        <>
          <Button type="button" variant="outline" className="w-full" onClick={openSlack}>
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
        </>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={inputId} className={compact ? 'sr-only' : undefined}>
          {t('bots.slack.token.label', 'Configuration refresh token')}
        </Label>
        <Input
          id={inputId}
          type="password"
          placeholder={compact ? `${SLACK_CONFIG_REFRESH_TOKEN_PREFIX}…` : undefined}
          autoComplete="off"
          spellCheck={false}
          value={token}
          aria-invalid={error !== null}
          onChange={(event) => {
            // What is typed wins over a clipboard read still pending.
            reads.current++
            setAccessPasted(false)
            setToken(event.target.value)
          }}
          onPaste={(event) => {
            if (take(event.clipboardData.getData('text'), true)) {
              event.preventDefault()
            }
          }}
        />
        {accessPasted ? (
          <p className="text-xs text-destructive">
            {t(
              'bots.slack.token.accessPasted',
              'That is the Access Token. Copy the Refresh Token, the one next to it.'
            )}
          </p>
        ) : error ? (
          <p className="text-xs text-destructive">{error}</p>
        ) : null}
      </div>
      <DialogFooter>
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('bots.slack.setup.cancel', 'Cancel')}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant={secondary ? 'outline' : 'default'}
          disabled={busy || !trimmed}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </form>
  )
}
