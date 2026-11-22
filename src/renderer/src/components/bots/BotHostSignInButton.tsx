import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { pairedWebServerSignInLine } from '../../../../shared/bots/paired-web-sign-in-copy'
import { useBotHostLabel, usePairedWebServerLabel } from './use-bot-host-label'
import { startBotHostSignIn } from '@/lib/bot-host-orca-account'
import { showSignInBesidePage } from './BotConnectorsHostNotice'
import { BotHostSignInBlocked, useBotHostSignInFromHere } from './bot-host-sign-in-from-here'
import type { Bot } from '../../../../shared/bot-types'

/**
 * A setup dialog's way out of "signed out of Orca": the sign-in of the computer the bot runs on.
 * A server's continues on the bot's Connectors notice, which shows its code to check; only a verified
 * server whose sign-in can work offers one, and any other says what stands in the way.
 */
export function BotHostSignInButton({
  bot,
  onClose
}: {
  bot: Bot
  onClose: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const host = useBotHostLabel(bot.hostId)
  const server = usePairedWebServerLabel()
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const signInFromHere = useBotHostSignInFromHere(bot.hostId)
  if (host && signInFromHere !== 'start') {
    return signInFromHere === null ? null : (
      <div className="flex flex-col gap-1 text-sm text-muted-foreground">
        <BotHostSignInBlocked hostId={bot.hostId} host={host} why={signInFromHere} />
      </div>
    )
  }
  if (!host && server) {
    return (
      <p className="text-sm text-muted-foreground">
        {t('bots.host.signIn.pairedWeb', pairedWebServerSignInLine('{{host}}'), { host: server })}
      </p>
    )
  }
  if (host) {
    return (
      <Button
        onClick={() => {
          onClose()
          showSignInBesidePage(bot.hostId, bot)
          void startBotHostSignIn(bot.hostId, bot)
        }}
      >
        {t('bots.host.signIn.start', 'Sign in on {{host}}', { host })}
      </Button>
    )
  }
  return (
    <Button
      onClick={() => {
        onClose()
        openSettingsTarget({ pane: 'orca-account', repoId: null })
        openSettingsPage()
      }}
    >
      {t('bots.slack.connection.signIn', 'Sign in')}
    </Button>
  )
}
