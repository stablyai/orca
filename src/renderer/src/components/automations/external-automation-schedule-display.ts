import type {
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations/external/external-automation'
import { isRunnableAutomationCronSchedule } from '../../../../shared/automations/scheduling/automation-schedule-parsing'
import { formatUiAutomationSchedule } from './automation-schedule-label'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export type ExternalAutomationScheduleDisplay = {
  label: string
}

function getDisplayableProviderSchedule(schedule: string): string | null {
  const trimmed = schedule.trim()
  const cronMatch = /^cron\s+(.+?)(?:\s+@\s+.+)?$/i.exec(trimmed)
  return cronMatch?.[1]?.trim() ?? trimmed
}

export function getExternalAutomationScheduleDisplay(
  _manager: ExternalAutomationManager,
  job: ExternalAutomationJob,
  t: Translate = translate,
  intlLocale?: string
): ExternalAutomationScheduleDisplay {
  const providerSchedule = job.schedule.trim()
  const candidateSchedules = [
    job.rawSchedule?.trim(),
    getDisplayableProviderSchedule(providerSchedule)
  ]

  for (const candidate of candidateSchedules) {
    if (candidate && isRunnableAutomationCronSchedule(candidate)) {
      return { label: formatUiAutomationSchedule(candidate, t, intlLocale) }
    }
  }

  if (providerSchedule) {
    return {
      label: providerSchedule.replace(/\s+@\s+.+$/, '')
    }
  }

  return {
    label: t(
      'auto.components.automations.external.automation.schedule.display.a8e92b815a',
      'Schedule unavailable'
    )
  }
}
