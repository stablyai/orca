import React from 'react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { useBotHostLabel } from './use-bot-host-label'
import { startBotHostSignIn } from '@/lib/bot-host-orca-account'
import { openBotConnectorsTab } from './bot-settings-open'
import type { Bot } from '../../../../shared/bot-types'

/**
 * A setup dialog's way out of "signed out of Orca": the sign-in of the computer the bot runs on.
 * A server's continues on the bot's Connectors notice, which shows its code to check.
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
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  if (host) {
    return (
      <Button
        onClick={() => {
          onClose()
          openBotConnectorsTab(bot)
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
