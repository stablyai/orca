import { getCheckConclusion } from '@/components/pr-check-counts'
import type {
  PRCheckAnnotation,
  PRCheckDetail,
  PRCheckJob
} from '../../../../shared/github/check-types'

export function getCheckStatusLabel(check: PRCheckDetail): string {
  const conclusion = getCheckConclusion(check)
  if (conclusion === 'success') {
    return 'Successful'
  }
  if (conclusion === 'failure') {
    return 'Failed'
  }
  if (conclusion === 'cancelled') {
    return 'Cancelled'
  }
  if (conclusion === 'timed_out') {
    return 'Timed out'
  }
  if (conclusion === 'action_required') {
    return 'Action required'
  }
  if (conclusion === 'neutral') {
    return 'Neutral'
  }
  if (conclusion === 'skipped') {
    return 'Skipped'
  }
  if (check.status === 'queued') {
    return 'Queued'
  }
  if (check.status === 'in_progress') {
    return 'In progress'
  }
  return 'Pending'
}

export function getCheckDetailsKey(check: PRCheckDetail): string {
  return String(check.checkRunId ?? check.workflowRunId ?? check.url ?? check.name)
}

// Why: check annotations carry no id, so identify them by the fields that make one distinct.
function getCheckAnnotationKey(annotation: PRCheckAnnotation): string {
  return [
    annotation.path ?? '',
    annotation.startLine ?? '',
    annotation.endLine ?? '',
    annotation.annotationLevel ?? '',
    annotation.title ?? '',
    annotation.message
  ].join('\0')
}

// Why: a check run can repeat a job name (matrix reruns) and omit the id, so fall back to the
// fields that separate two same-named jobs.
function getCheckJobKey(job: PRCheckJob): string {
  return job.id !== null
    ? String(job.id)
    : [job.name, job.url ?? '', job.startedAt ?? '', job.completedAt ?? ''].join('\0')
}

// Why: identical twins are indistinguishable, so suffix repeats to keep list keys unique.
function withUniqueKeys<T>(items: T[], getKey: (item: T) => string): { key: string; item: T }[] {
  const seen = new Map<string, number>()
  return items.map((item) => {
    const base = getKey(item)
    const repeat = seen.get(base) ?? 0
    seen.set(base, repeat + 1)
    return { key: repeat === 0 ? base : `${base}#${repeat}`, item }
  })
}

export function getKeyedCheckAnnotations(
  annotations: PRCheckAnnotation[]
): { key: string; item: PRCheckAnnotation }[] {
  return withUniqueKeys(annotations, getCheckAnnotationKey)
}

export function getKeyedCheckJobs(jobs: PRCheckJob[]): { key: string; item: PRCheckJob }[] {
  return withUniqueKeys(jobs, getCheckJobKey)
}

export function formatCheckTimestamp(input: string | null | undefined): string | null {
  if (!input) {
    return null
  }
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) {
    return null
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
