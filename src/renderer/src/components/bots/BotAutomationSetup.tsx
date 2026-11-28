import type { Automation } from '../../../../shared/automations/automation-definition'
import { useTranslate } from '@/i18n/use-translate'
import {
  DetailPropertySection,
  useAutomationDetailProperties
} from '../automations/details/automation-detail-sections'
import { botTargetChatTitle } from '../automations/authoring/automation-bot-runs-in-chat'
/** Setup: the page's Execution and Schedule rows a bot automation has. */
export function BotAutomationSetup({
  automation,
  hostName,
  botName
}: {
  automation: Automation
  hostName: string
  botName: string
}): React.JSX.Element {
  const t = useTranslate()
  const properties = useAutomationDetailProperties({
    automation,
    workspaceName: '',
    projectDefaultBaseRef: null
  })
  const pick = new Set(['agent', 'grace'])
  return (
    <DetailPropertySection
      title={t('bots.automationPanel.setup', 'Setup')}
      properties={[
        ...properties.execution.filter((property) => pick.has(property.key)),
        {
          key: 'runsIn',
          label: t('automations.botTarget.runsIn', 'Runs in'),
          value: automation.bot?.chat
            ? botTargetChatTitle(automation.bot.chat)
            : automation.bot?.runsIn === 'chat'
              ? t('automations.botTarget.chat', "{{name}}'s Chat", { name: botName })
              : t('automations.botTarget.runsInNew', 'A new conversation each time')
        },
        {
          key: 'computer',
          label: t('bots.automationPanel.computer', 'Computer'),
          value: hostName
        },
        ...properties.schedule.filter((property) => pick.has(property.key))
      ]}
    />
  )
}
