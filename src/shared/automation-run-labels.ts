// Untranslated run wording for the phone's bot sheet; the desktop's translated copy is in automation-page-parts.
import type { AutomationRun } from './automations/history/automation-run'
import { regionalDateTimeFormat } from './i18n/regional-date-time-format'

// Reuse one formatter across run cells; per-cell construction dominates large-history rendering.
const AUTOMATION_DATE_TIME: Intl.DateTimeFormatOptions = {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
}

export function formatAutomationDateTime(value: number | null | undefined): string {
  if (!value) {
    return 'Never'
  }
  return regionalDateTimeFormat(AUTOMATION_DATE_TIME).format(value)
}

export function getAutomationRunStatusLabel(status: AutomationRun['status']): string {
  switch (status) {
    case 'pending':
      return 'Queued'
    case 'dispatching':
      return 'Starting'
    case 'dispatched':
      return 'Launched'
    case 'completed':
      return 'Done'
    case 'skipped_precheck':
      return 'Precheck skipped'
    case 'skipped_missed':
      return 'Skipped'
    case 'skipped_unavailable':
      return 'Unavailable'
    case 'skipped_needs_interactive_auth':
      return 'Needs credentials'
    case 'dispatch_failed':
      return 'Failed'
  }
}
