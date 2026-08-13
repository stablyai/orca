import { translate } from '@/i18n/i18n'
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  ExternalAutomationJob
} from '../../../../shared/automations-types'
import {
  formatAutomationDateTime,
  formatAutomationRelativeTime,
  getAutomationRunStatusLabel
} from './automation-page-parts'

export type AutomationLastRunTone =
  | 'failed'
  | 'succeeded'
  | 'running'
  | 'skipped'
  | 'never'
  | 'unknown'

export type AutomationLastRunSnapshot = {
  at: number | null
  tone: AutomationLastRunTone
  statusLabel: string
}

const EXTERNAL_FAILED_STATUSES = new Set(['failed', 'fail', 'error', 'dispatch_failed'])
const EXTERNAL_SUCCEEDED_STATUSES = new Set([
  'ok',
  'completed',
  'success',
  'succeeded',
  'done',
  'healthy'
])

export function indexLatestAutomationRuns(
  runs: readonly AutomationRun[]
): ReadonlyMap<string, AutomationRun> {
  const latest = new Map<string, AutomationRun>()
  for (const run of runs) {
    const existing = latest.get(run.automationId)
    if (!existing || run.createdAt > existing.createdAt) {
      latest.set(run.automationId, run)
    }
  }
  return latest
}

export function getAutomationRunLastRunAt(run: AutomationRun): number {
  return run.dispatchedAt ?? run.startedAt ?? run.createdAt
}

export function getToneForAutomationRunStatus(status: AutomationRunStatus): AutomationLastRunTone {
  if (status === 'dispatch_failed') {
    return 'failed'
  }
  if (status === 'completed') {
    return 'succeeded'
  }
  if (status === 'pending' || status === 'dispatching' || status === 'dispatched') {
    return 'running'
  }
  if (status.startsWith('skipped')) {
    return 'skipped'
  }
  return 'unknown'
}

export function getLocalAutomationLastRunSnapshot(
  automation: Automation,
  lastRun: AutomationRun | undefined
): AutomationLastRunSnapshot {
  if (lastRun) {
    return {
      at: getAutomationRunLastRunAt(lastRun),
      tone: getToneForAutomationRunStatus(lastRun.status),
      statusLabel: getAutomationRunStatusLabel(lastRun.status)
    }
  }
  if (automation.lastRunAt) {
    return {
      at: automation.lastRunAt,
      tone: 'unknown',
      statusLabel: ''
    }
  }
  return { at: null, tone: 'never', statusLabel: '' }
}

function parseExternalLastRunAt(value: string | null): number | null {
  if (!value) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function getExternalAutomationLastRunSnapshot(
  job: ExternalAutomationJob
): AutomationLastRunSnapshot {
  const at = parseExternalLastRunAt(job.lastRunAt)
  const raw = job.lastStatus?.trim() ?? ''
  const normalized = raw.toLowerCase()
  if (!at && !raw && !job.lastError) {
    return { at: null, tone: 'never', statusLabel: '' }
  }
  if (EXTERNAL_SUCCEEDED_STATUSES.has(normalized)) {
    return {
      at,
      tone: 'succeeded',
      statusLabel: translate('auto.components.automations.automation.list.last.run.done', 'Done')
    }
  }
  if (EXTERNAL_FAILED_STATUSES.has(normalized) || Boolean(job.lastError)) {
    return {
      at,
      tone: 'failed',
      statusLabel: translate(
        'auto.components.automations.automation.list.last.run.failed',
        'Failed'
      )
    }
  }
  if (raw) {
    return { at, tone: 'unknown', statusLabel: raw }
  }
  return { at, tone: 'unknown', statusLabel: '' }
}

export function formatAutomationLastRunCell(
  snapshot: AutomationLastRunSnapshot,
  now: number
): { text: string; title: string; tone: AutomationLastRunTone } {
  const status = snapshot.statusLabel.trim()
  if (snapshot.tone === 'never') {
    const never = formatAutomationDateTime(null)
    return { text: never, title: never, tone: 'never' }
  }
  if (snapshot.at == null) {
    return { text: status || formatAutomationDateTime(null), title: status, tone: snapshot.tone }
  }
  const relative = formatAutomationRelativeTime(snapshot.at, now)
  const absolute = formatAutomationDateTime(snapshot.at)
  const text = status && relative ? `${status} ${relative}` : status || relative || absolute
  return {
    text,
    title: status ? `${status} · ${absolute}` : absolute,
    tone: snapshot.tone
  }
}
