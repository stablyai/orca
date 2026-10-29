import type { AutomationRun } from '../../../../shared/automations-types'
import { translate } from '@/i18n/i18n'

export function getAutomationRunContent(run: AutomationRun): string {
  const savedOutput = run.outputSnapshot?.content.trim()
  if (savedOutput) {
    return run.outputSnapshot?.content ?? savedOutput
  }
  if (run.precheckResult) {
    const output = [run.precheckResult.stderr.trim(), run.precheckResult.stdout.trim()]
      .filter(Boolean)
      .join('\n\n')
    if (output) {
      return output
    }
  }
  return (
    run.error ??
    run.usage?.unavailableMessage ??
    translate('auto.components.automations.runContent.noOutput', 'No output content available.')
  )
}
