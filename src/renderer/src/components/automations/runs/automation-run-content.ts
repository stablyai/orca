import type { AutomationRun } from '../../../../../shared/automations/history/automation-run'
import { getAutomationRunContent as getSharedAutomationRunContent } from '../../../../../shared/automations/history/automation-run-content'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { automationRunErrorText } from './automation-run-error-copy'

export function getAutomationRunContent(run: AutomationRun, t: Translate = translate): string {
  return getSharedAutomationRunContent(
    { ...run, error: automationRunErrorText(run) },
    t('auto.components.automations.runContent.noOutput', 'No output content available.')
  )
}
