import { useTranslate } from '@/i18n/use-translate'
import type { Automation } from '../../../../shared/automations/automation-definition'
import { AutomationPromptDisclosure } from '../automations/details/AutomationPromptDisclosure'

export function BotAutomationInstructions({
  automation
}: {
  automation: Automation
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <AutomationPromptDisclosure
      key={`${automation.id}:${automation.prompt}`}
      prompt={automation.prompt}
      title={t('bots.automationPanel.instructions', 'Instructions')}
      copyNoun="instructions"
    />
  )
}
