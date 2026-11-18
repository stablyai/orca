import React from 'react'
import { LinearIcon } from '@/components/icons/LinearIcon'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot, BotLinear } from '../../../../../shared/bot-types'
import type { ConnectorLinearWorkspace } from '../../../../../shared/connector-bot-linear-contract'
import { BotWhoCanAskList } from '../BotWhoCanAskList'
import { ConnectorSetupList, ConnectorSetupSection } from '../connector-connect-parts'
import { linearWorkspaceLabel } from './bot-linear-copy'
import { useLinearWhoCanAsk } from './use-linear-who-can-ask'

/** Once linked in a workspace, the owner picks who there may ask the bot. */
export function LinkedPeople({ bot, linear }: { bot: Bot; linear: BotLinear }): React.JSX.Element {
  return <BotWhoCanAskList bot={bot} service={useLinearWhoCanAsk(bot.hostId, linear, true)} />
}

/** The done screen's Workspace: the one the bot was just turned on in. */
export function LinearWorkspaceSection({
  workspace
}: {
  workspace: ConnectorLinearWorkspace
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <ConnectorSetupSection label={t('bots.linear.setup.workspace', 'Workspace')}>
      <ConnectorSetupList
        items={[
          {
            key: workspace.workspaceId,
            icon: <LinearIcon className="size-4" />,
            label: linearWorkspaceLabel(workspace.name, workspace.urlKey)
          }
        ]}
      />
    </ConnectorSetupSection>
  )
}
