// @protected-copy: drawn inside the security-surface setup dialog
import React from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { refreshBotLinear } from '@/lib/bot-linear-state'
import { cancelConnectorConnect, useConnectorConnect } from '@/lib/connector-connect-state'
import { ConnectorSetupDialog, useSetupStepAside } from '../connector-setup-surface'
import { useConnectorSetupOpen } from '@/lib/connector-setup-open'
import { botLinearWorkspaces, type Bot } from '../../../../../shared/bot-types'
import { useReadOnOpen } from '../connector-connect-parts'
import { OrcaCloudSignInGate, orcaCloudSignInReason } from '../orca-cloud-sign-in'
import { BotLinearSetupFlow, LINEAR } from './BotLinearSetupFlow'

/** "Add connector → Linear": one browser trip signs in (installing Orca on the way), then the bot is turned on. */
export function BotLinearSetupDialog({
  bot,
  workspaceId,
  open,
  onOpenChange
}: {
  bot: Bot
  /** A workspace the bot is already in; none adds it to Linear, or to another workspace. */
  workspaceId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const on = useReadOnOpen(open, () =>
    botLinearWorkspaces(bot).some((entry) => entry.workspaceId === workspaceId)
  )
  // An "Open Orca" return lands here instead of sending the owner to Settings.
  useConnectorSetupOpen(open)
  const setOpen = (next: boolean): void => {
    // Closing stops listening for a trip still in the browser.
    if (!next) {
      cancelConnectorConnect(bot.hostId, 'linear')
    }
    onOpenChange(next)
  }
  const title = on
    ? t('bots.linear.setup.titleOn', '{{name}} in Linear', { name: bot.name })
    : t('bots.linear.setup.title', 'Add {{name}} to Linear', { name: bot.name })
  // Away while Linear's page is in Orca's browser; the flow comes back once the sign-in ends.
  const waiting = useConnectorConnect(bot.hostId, 'linear').status === 'waiting'
  const aside = useSetupStepAside()
  return (
    <ConnectorSetupDialog
      open={open}
      onOpenChange={setOpen}
      aside={aside}
      connector={LINEAR}
      service="Linear"
      botName={bot.name}
      waiting={waiting}
    >
      <OrcaCloudSignInGate
        hostId={bot.hostId}
        title={title}
        reason={orcaCloudSignInReason('linear')}
        onCancel={() => setOpen(false)}
        resume={() => refreshBotLinear(bot.hostId)}
      >
        <BotLinearSetupFlow
          bot={bot}
          workspaceId={workspaceId}
          on={on}
          title={title}
          onClose={() => setOpen(false)}
          aside={aside}
        />
      </OrcaCloudSignInGate>
    </ConnectorSetupDialog>
  )
}
