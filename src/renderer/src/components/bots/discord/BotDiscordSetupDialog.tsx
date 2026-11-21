// @protected-copy: drawn inside the security-surface setup dialog
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotDiscord } from '@/lib/bot-discord-state'
import { useConnectorSetupOpen } from '@/lib/connector-setup-open'
import { ConnectorSetupDialog, useSetupStepAside } from '../connector-setup-surface'
import { botDiscordGuilds, type Bot } from '../../../../../shared/bot-types'
import { useReadOnOpen } from '../connector-connect-parts'
import { OrcaCloudSignInGate, orcaCloudSignInReason } from '../orca-cloud-sign-in'
import { BotDiscordSetupFlow, DISCORD } from './BotDiscordSetupFlow'

/** "Add connector → Discord": the bot's own Discord application and its token, then a server to add it to. */
export function BotDiscordSetupDialog({
  bot,
  guildId,
  open,
  onOpenChange
}: {
  bot: Bot
  /** A server the bot is already in; none adds it to Discord, or to another server. */
  guildId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const on = useReadOnOpen(open, () => botDiscordGuilds(bot).length > 0)
  useConnectorSetupOpen(open)
  const title = on
    ? t('bots.discord.setup.titleOn', '{{name}} in Discord', { name: bot.name })
    : t('bots.discord.setup.title', 'Add {{name}} to Discord', { name: bot.name })
  // Nothing opens in Orca's browser, so the dialog never steps aside.
  const aside = useSetupStepAside()
  return (
    <ConnectorSetupDialog
      open={open}
      onOpenChange={onOpenChange}
      aside={aside}
      connector={DISCORD}
      service="Discord"
      botName={bot.name}
      waiting={false}
    >
      <OrcaCloudSignInGate
        hostId={bot.hostId}
        title={title}
        reason={orcaCloudSignInReason('discord')}
        onCancel={() => onOpenChange(false)}
        resume={() => refreshBotDiscord(bot.hostId)}
      >
        {open ? (
          <BotDiscordSetupFlow
            bot={bot}
            guildId={guildId}
            title={title}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </OrcaCloudSignInGate>
    </ConnectorSetupDialog>
  )
}
