// One installed Slack workspace's body, the same in the connector panel and the after-install dialog:
// how to ask, Who can ask, and who messages typed in Orca show as.
import React, { useState } from 'react'
import { toast } from 'sonner'
import { SettingsSwitchRow } from '@/components/settings/form-controls/SettingsFormControls'
import { SettingsGroup } from '@/components/settings/section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { botSlackCalls } from '@/lib/bot-connector-host-calls'
import { refreshBotSlack } from '@/lib/bot-slack-state'
import type { Bot } from '../../../../../shared/bot-types'
import type { ConnectorBotSlackState } from '../../../../../shared/connector-bot-slack-contract'
import { BotHowToAsk, HOW_TO_ASK_ESCAPED } from '../BotHowToAsk'
import { BotWhoCanAskInsetList } from '../BotWhoCanAskInsetList'
import { useBotConnectorPaged } from '../bot-connector-page'
import { BotConnectorSection } from '../bot-connector-people'
import { BotSlackPostAs } from './BotSlackPostAs'
import { useSlackWhoCanAsk } from './use-slack-who-can-ask'

export function BotSlackSection({
  bot,
  slack,
  setupState
}: {
  bot: Bot
  slack: Extract<ConnectorBotSlackState, { state: 'installed' }>
  /** The after-install dialog's install link state: its identity pick applies at once. */
  setupState?: string
}): React.JSX.Element {
  const t = useTranslate()
  const people = useSlackWhoCanAsk(bot, slack.teamId)
  // On the connector's own page each part is a captioned card; the dialog reads as one block.
  const paged = useBotConnectorPaged()
  return (
    <div>
      <BotConnectorSection title={paged ? t('bots.connector.howToAsk', 'How to ask') : undefined}>
        <p className="mb-3 text-xs leading-5 text-muted-foreground">
          <BotHowToAsk
            text={t(
              'bots.slack.mentionLine',
              'Mention <code>@{{name}}</code> in a channel or DM.',
              {
                name: bot.name,
                ...HOW_TO_ASK_ESCAPED
              }
            )}
          />
        </p>
      </BotConnectorSection>
      <BotWhoCanAskInsetList bot={bot} service={people} />
      <BotConnectorSection>
        <BotSlackPostAs
          bot={bot}
          slack={slack}
          setupState={setupState}
          className={paged ? undefined : 'mt-3 px-3'}
        />
      </BotConnectorSection>
      {paged && slack.showOrcaThreadLink !== undefined ? (
        <BotSlackThreadLink bot={bot} teamId={slack.teamId} checked={slack.showOrcaThreadLink} />
      ) : null}
    </div>
  )
}

function BotSlackThreadLink({
  bot,
  teamId,
  checked
}: {
  bot: Bot
  teamId: string
  checked: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    setSaving(true)
    const showOrcaThreadLink = !checked
    const result = await botSlackCalls(bot.hostId).setThreadLink({
      botId: bot.id,
      teamId,
      showOrcaThreadLink
    })
    await refreshBotSlack(bot, !result.ok)
    setSaving(false)
    if (!result.ok || result.value.showOrcaThreadLink !== showOrcaThreadLink) {
      toast.error(
        t('bots.slack.threadLink.saveFailed', 'Couldn’t save the Slack reply link setting.')
      )
    }
  }

  return (
    <SettingsGroup className="mt-3.5">
      <SettingsSwitchRow
        label={t('bots.slack.threadLink.label', 'Show “Open this thread in Orca” link')}
        description={t(
          'bots.slack.threadLink.description',
          'Include the link in new bot replies in this workspace.'
        )}
        checked={checked}
        disabled={saving}
        onChange={() => void save()}
      />
    </SettingsGroup>
  )
}
