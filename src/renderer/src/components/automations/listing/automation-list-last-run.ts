import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type {
  AutomationRun,
  AutomationRunStatus
} from '../../../../../shared/automations/history/automation-run'
import type { ExternalAutomationJob } from '../../../../../shared/automations/external/external-automation'
import {
  formatAutomationDateTime,
  formatAutomationRelativeTime,
  getAutomationRunStatusLabel
} from '../automation-page-parts'

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

/** Use the authority-projected newest retained run without fetching history; legacy servers fall back to stored lastRunAt alone. */
export function getAutomationRowLastRunSnapshot(
  row: {
    automation: Automation
    usageSummary: { lastRunStatus?: AutomationRunStatus | null; lastRunAt?: number | null } | null
  },
  t?: Translate
): AutomationLastRunSnapshot {
  const status = row.usageSummary?.lastRunStatus
  if (status) {
    return {
      at: row.usageSummary?.lastRunAt ?? row.automation.lastRunAt ?? null,
      tone: getToneForAutomationRunStatus(status),
      statusLabel: getAutomationRunStatusLabel(status, t)
    }
  }
  return getLocalAutomationLastRunSnapshot(row.automation, undefined, t)
}

export function getLocalAutomationLastRunSnapshot(
  automation: Automation,
  lastRun: AutomationRun | undefined,
  t?: Translate
): AutomationLastRunSnapshot {
  if (lastRun) {
    return {
      at: getAutomationRunLastRunAt(lastRun),
      tone: getToneForAutomationRunStatus(lastRun.status),
      statusLabel: getAutomationRunStatusLabel(lastRun.status, t)
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
  job: ExternalAutomationJob,
  t: Translate = translate
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
      statusLabel: t('auto.components.automations.automation.list.last.run.done', 'Done')
    }
  }
  if (EXTERNAL_FAILED_STATUSES.has(normalized) || Boolean(job.lastError)) {
    return {
      at,
      tone: 'failed',
      statusLabel: t('auto.components.automations.automation.list.last.run.failed', 'Failed')
    }
  }
  if (raw) {
    return { at, tone: 'unknown', statusLabel: raw }
  }
  return { at, tone: 'unknown', statusLabel: '' }
}

export function formatAutomationLastRunCell(
  snapshot: AutomationLastRunSnapshot,
  now: number,
  t: Translate = translate,
  intlLocale?: string
): { text: string; title: string; tone: AutomationLastRunTone } {
  const status = snapshot.statusLabel.trim()
  if (snapshot.tone === 'never') {
    const never = formatAutomationDateTime(null, t, intlLocale)
    return { text: never, title: never, tone: 'never' }
  }
  if (snapshot.at == null) {
    return {
      text: status || formatAutomationDateTime(null, t, intlLocale),
      title: status,
      tone: snapshot.tone
    }
  }
  const relative = formatAutomationRelativeTime(snapshot.at, now, t, intlLocale)
  const absolute = formatAutomationDateTime(snapshot.at, t, intlLocale)
  const text =
    status && relative
      ? t(
          'auto.components.automations.automation.list.last.run.statusWithRelative',
          '{{status}} {{relative}}',
          { status, relative }
        )
      : status || relative || absolute
  return {
    text,
    title: status ? `${status} · ${absolute}` : absolute,
    tone: snapshot.tone
  }
}
