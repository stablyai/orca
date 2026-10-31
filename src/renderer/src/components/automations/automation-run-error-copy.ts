import { translate } from '@/i18n/i18n'
import { isAutomationRunFailureCode } from '../../../../shared/automation-run-failure-copy'
import { localizedAutomationRunFailure } from '../../../../shared/automation-run-failure-localization'
import type { AutomationRun } from '../../../../shared/automations-types'

/** Details preserve old raw errors; notifications use only the checked localized reason. */
export function automationRunErrorText(
  run: Pick<AutomationRun, 'error' | 'errorCode' | 'errorParams'>
): string | null {
  return run.error === null || !isAutomationRunFailureCode(run.errorCode)
    ? run.error
    : (localizedAutomationRunFailure(run.errorCode, run.errorParams, translate) ?? run.error)
}
