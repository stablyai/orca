import type {
  ExternalAutomationJob,
  ExternalAutomationManager
} from '../../../../shared/automations-types'
import {
  formatAutomationSchedule,
  isValidAutomationCronSchedule
} from '../../../../shared/automation-schedules'

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
  job: ExternalAutomationJob
): ExternalAutomationScheduleDisplay {
  const providerSchedule = job.schedule.trim()
  const candidateSchedules = [
    job.rawSchedule?.trim(),
    getDisplayableProviderSchedule(providerSchedule)
  ]

  for (const candidate of candidateSchedules) {
    if (candidate && isValidAutomationCronSchedule(candidate)) {
      return { label: formatAutomationSchedule(candidate) }
    }
  }

  if (providerSchedule) {
    return {
      label: providerSchedule.replace(/\s+@\s+.+$/, '')
    }
  }

  return {
    label: 'Schedule unavailable'
  }
}
