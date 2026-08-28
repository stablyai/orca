import type { AppState } from '@/store/types'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { JiraIssue } from '../../../../shared/jira-types'
import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { WorkLogEntry, WorkLogProvider } from '../../../../shared/work-log-types'

export type WorkLogDraft = {
  date: string
  startTime: string
  endTime: string
  title: string
  provider: WorkLogProvider
  reference: string
  notes: string
  badgeDerived: boolean
}

export type WorktreeActivitySummary = {
  hasPermission: boolean
  hasLiveWorking: boolean
  hasLiveMonitoring: boolean
  hasInterrupted: boolean
  hasLiveDone: boolean
  hasRetainedDone: boolean
}

export const WORK_LOG_PROVIDER_OPTIONS: {
  value: WorkLogProvider
  label: string
  description: string
}[] = [
  {
    value: 'activity',
    label: 'Activity',
    description: 'Badge-derived focus from the current workspace'
  },
  { value: 'github', label: 'GitHub', description: 'Issue or pull request' },
  { value: 'gitlab', label: 'GitLab', description: 'Issue or merge request' },
  { value: 'linear', label: 'Linear', description: 'Issue or project task' },
  { value: 'jira', label: 'Jira', description: 'Issue or backlog item' },
  {
    value: 'azure-devops',
    label: 'Azure DevOps',
    description: 'Work item or sprint task'
  },
  { value: 'ninjaone', label: 'NinjaOne', description: 'Ticket or service item' },
  { value: 'planner', label: 'Planner', description: 'Planner task or bucket item' }
]

export const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: 'short',
  month: 'short',
  day: 'numeric'
})

const CLOCK_LABEL_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric',
  minute: '2-digit'
})

export function createLocalDateKey(date = new Date()): string {
  const year = date.getFullYear()
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function parseLocalDateKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split('-').map((value) => Number(value))
  return new Date(year, month - 1, day)
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

export function localDateKeyFromTimestamp(timestamp: number): string {
  return createLocalDateKey(new Date(timestamp))
}

export function minutesBetween(startAt: number, endAt: number): number {
  return Math.max(0, Math.round((endAt - startAt) / 60000))
}

export function formatDuration(minutes: number): string {
  if (minutes <= 0) {
    return '0m'
  }
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours === 0) {
    return `${remainder}m`
  }
  if (remainder === 0) {
    return `${hours}h`
  }
  return `${hours}h ${remainder}m`
}

export function formatHours(minutes: number): string {
  return `${(minutes / 60).toFixed(minutes % 60 === 0 ? 0 : 1)}h`
}

export function formatClockRange(startAt: number, endAt: number): string {
  return `${CLOCK_LABEL_FORMATTER.format(new Date(startAt))} - ${CLOCK_LABEL_FORMATTER.format(
    new Date(endAt)
  )}`
}

export function getEntryProviderLabel(provider: WorkLogProvider): string {
  return WORK_LOG_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider
}

export function getEntryTitle(entry: WorkLogEntry): string {
  const providerLabel = getEntryProviderLabel(entry.provider)
  return entry.reference ? `${entry.title} · ${providerLabel} ${entry.reference}` : entry.title
}

export function buildTimestamp(dateKey: string, timeValue: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !/^\d{2}:\d{2}$/.test(timeValue)) {
    return null
  }
  const date = new Date(`${dateKey}T${timeValue}:00`)
  return Number.isFinite(date.getTime()) ? date.getTime() : null
}

export function summarizeTaskPageData(taskPageData: AppState['taskPageData']): {
  label: string
  provider: WorkLogProvider | null
  reference: string | null
  title: string | null
} {
  if (taskPageData.openGitHubWorkItem) {
    const item = taskPageData.openGitHubWorkItem as GitHubWorkItem
    return {
      label: 'GitHub task',
      provider: 'github',
      reference: `#${item.number}`,
      title: item.title
    }
  }
  if (taskPageData.openGitLabWorkItem) {
    const item = taskPageData.openGitLabWorkItem as GitLabWorkItem
    return {
      label: 'GitLab task',
      provider: 'gitlab',
      reference: `!${item.number}`,
      title: item.title
    }
  }
  if (taskPageData.openLinearIssue) {
    const issue = taskPageData.openLinearIssue as LinearIssue
    return {
      label: 'Linear issue',
      provider: 'linear',
      reference: issue.identifier,
      title: issue.title
    }
  }
  if (taskPageData.openJiraIssue) {
    const issue = taskPageData.openJiraIssue as JiraIssue
    return {
      label: 'Jira issue',
      provider: 'jira',
      reference: issue.key,
      title: issue.title
    }
  }
  if (taskPageData.taskSource) {
    const provider =
      taskPageData.taskSource === 'github' ||
      taskPageData.taskSource === 'gitlab' ||
      taskPageData.taskSource === 'linear' ||
      taskPageData.taskSource === 'jira'
        ? taskPageData.taskSource
        : null
    return {
      label: 'Task surface',
      provider,
      reference: null,
      title: null
    }
  }
  return { label: 'Task surface', provider: null, reference: null, title: null }
}

export function badgeDerivedEstimateMinutes(summary: WorktreeActivitySummary | null): number {
  if (!summary) {
    return 0
  }
  let minutes = 0
  if (summary.hasLiveWorking) {
    minutes += 60
  }
  if (summary.hasLiveMonitoring) {
    minutes += 30
  }
  if (summary.hasPermission) {
    minutes += 30
  }
  if (summary.hasInterrupted) {
    minutes += 15
  }
  if (summary.hasLiveDone) {
    minutes += 20
  }
  if (summary.hasRetainedDone) {
    minutes += 20
  }
  return minutes
}

export function filterEntriesForDay(
  entries: readonly WorkLogEntry[],
  dateKey: string
): WorkLogEntry[] {
  return entries.filter((entry) => localDateKeyFromTimestamp(entry.startAt) === dateKey)
}

export function buildWeekWindow(dateKey: string): string[] {
  const start = startOfLocalDay(parseLocalDateKey(dateKey))
  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start)
    day.setDate(start.getDate() - (6 - index))
    return createLocalDateKey(day)
  })
}
