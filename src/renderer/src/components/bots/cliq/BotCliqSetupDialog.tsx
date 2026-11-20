// @protected-copy: drawn inside the security-surface setup dialog
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotCliq } from '@/lib/bot-cliq-state'
import { cancelConnectorConnect, useConnectorConnect } from '@/lib/connector-connect-state'
import { ConnectorSetupDialog, useSetupStepAside } from '../connector-setup-surface'
import { useConnectorSetupOpen } from '@/lib/connector-setup-open'
import { botCliqBots, type Bot } from '../../../../../shared/bot-types'
import { useReadOnOpen } from '../connector-connect-parts'
import { OrcaCloudSignInGate, orcaCloudSignInReason } from '../orca-cloud-sign-in'
import { BotCliqSetupFlow, CLIQ } from './BotCliqSetupFlow'

/** "Add connector → Zoho Cliq": one browser trip signs in to Zoho, then the bot gets its own Cliq bot. */
export function BotCliqSetupDialog({
  bot,
  orgId,
  open,
  onOpenChange
}: {
  bot: Bot
  /** An organization the bot is already in; none adds it to Cliq, or to another organization. */
  orgId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const on = useReadOnOpen(open, () => botCliqBots(bot).some((entry) => entry.orgId === orgId))
  // An "Open Orca" return lands here instead of sending the owner to Settings.
  useConnectorSetupOpen(open)
  const setOpen = (next: boolean): void => {
    if (!next) {
      cancelConnectorConnect(bot.hostId, 'cliq')
    }
    onOpenChange(next)
  }
  const title = on
    ? t('bots.cliq.setup.titleOn', '{{name}} in Zoho Cliq', { name: bot.name })
    : t('bots.cliq.setup.title', 'Add {{name}} to Zoho Cliq', { name: bot.name })
  const waiting = useConnectorConnect(bot.hostId, 'cliq').status === 'waiting'
  const aside = useSetupStepAside()
  return (
    <ConnectorSetupDialog
      open={open}
      onOpenChange={setOpen}
      aside={aside}
      connector={CLIQ}
      service="Zoho Cliq"
      botName={bot.name}
      waiting={waiting}
    >
      <OrcaCloudSignInGate
        hostId={bot.hostId}
        title={title}
        reason={orcaCloudSignInReason('cliq')}
        onCancel={() => setOpen(false)}
        resume={() => refreshBotCliq(bot.hostId)}
      >
        <BotCliqSetupFlow
          bot={bot}
          orgId={orgId}
          on={on}
          title={title}
          onClose={() => setOpen(false)}
          aside={aside}
        />
      </OrcaCloudSignInGate>
    </ConnectorSetupDialog>
  )
}
