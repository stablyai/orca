import React, { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { BotAppLogo } from '../apps/BotAppRow'
import { BotAppBrowserWait, BotAppOutcome } from '../apps/BotAppStepParts'
import { openComposioPage, useComposioBot } from './composio-client'

/**
 * A Composio app's sign-in, waited for in Add to <bot>. The host drops its wait when the sign-in
 * ends: connected hands over to the new row; ended without a sign-in (denied, failed, or past
 * the host's time limit) shows why and offers Try again. Mounted once per attempt.
 */
export function ComposioSignInWait({
  bot,
  app,
  connectError,
  onDone,
  onRetry,
  onClose
}: {
  bot: Bot
  app: { slug: string; name: string; logo?: string | null }
  /** Connect itself failed, before any browser trip. */
  connectError: string | null
  onDone: () => void
  onRetry: () => void
  /** Leaves the sign-in running in the browser. */
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const view = useComposioBot(bot)
  const pending = (view.connections?.pending ?? []).find((entry) => entry.app === app.slug)
  const waiting = pending !== undefined
  const connected =
    !waiting &&
    (view.connections?.connections ?? []).some(
      (entry) => entry.app === app.slug && entry.status === 'active'
    )
  // The wait only counts as ended once the host was seen holding it.
  const [seenWaiting, setSeenWaiting] = useState(false)
  if (waiting && !seenWaiting) {
    setSeenWaiting(true)
  }
  const failed = connectError !== null || (seenWaiting && !waiting && !connected)
  // The host says when the browser sign-in finishes; the dialog then hands over to the new row.
  useEffect(() => {
    if (connected && seenWaiting) {
      onDone()
    }
  }, [connected, seenWaiting, onDone])
  const logo = <BotAppLogo slug={app.slug} logo={app.logo} size="lg" />
  if (failed) {
    return (
      <BotAppOutcome
        logo={logo}
        badge="failed"
        title={t('bots.apps.couldNotSignIn', 'Couldn’t sign in to {{app}}', { app: app.name })}
        line={
          connectError ??
          t('bots.composio.signInEnded', 'The sign-in was turned down, failed, or took too long.')
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('bots.apps.close', 'Close')}
            </Button>
            <Button size="sm" onClick={onRetry}>
              {t('bots.composio.tryAgain', 'Try again')}
            </Button>
          </>
        }
      />
    )
  }
  return (
    <BotAppBrowserWait
      logo={logo}
      line={t('bots.composio.signInOnComposio', 'Sign in to {{app}} on Composio’s page.', {
        app: app.name
      })}
      onClose={onClose}
      onOpenAgain={pending ? () => openComposioPage(pending.url) : undefined}
    />
  )
}
