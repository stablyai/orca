import { z } from 'zod'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { translate } from '@/i18n/i18n'

export const taskNoteSchema = z.object({
  status: z.enum(['automatic', 'waiting-user', 'waiting-input', 'verified']),
  title: z.string().max(120),
  summary: z.string().max(240),
  nextStep: z.string().max(240),
  owner: z.string().max(120),
  reviewReference: z.string().max(500),
  observation: z.string().max(500),
  savedAt: z.number().finite().nonnegative()
})

export type DashboardTaskNote = z.infer<typeof taskNoteSchema>
export type DashboardTaskBucket = DashboardCard['bucket'] | 'waiting-input'
export const TASK_BUCKET_ORDER: readonly DashboardTaskBucket[] = [
  'attention',
  'working',
  'waiting-input',
  'done',
  'idle'
]
export const RECENT_RESPONSE_MS = 48 * 60 * 60 * 1000

export function taskNoteIdentity(card: DashboardCard): string {
  return JSON.stringify([
    card.hostKind ?? 'local',
    card.executionHostId ?? 'local',
    card.repoId,
    card.worktreeId,
    card.paneKey
  ])
}

export function taskObservation(card: DashboardCard): string {
  return JSON.stringify([
    card.startedAt,
    card.finishedAt,
    card.stateChangedAt,
    card.dotState,
    card.verdict ?? null
  ])
}

export function currentTaskNote(
  card: DashboardCard,
  note: DashboardTaskNote | undefined
): DashboardTaskNote | undefined {
  return note?.observation === taskObservation(card) ? note : undefined
}

/** Read acknowledgement changes the bucket, not the completed response. */
export function hasCompletedResponse(card: DashboardCard): boolean {
  return (
    (card.bucket === 'done' || card.bucket === 'idle') &&
    card.dotState === 'done' &&
    card.finishedAt !== null &&
    Number.isFinite(card.finishedAt) &&
    card.finishedAt > 0
  )
}

export function taskResultVerified(card: DashboardCard, note?: DashboardTaskNote): boolean {
  const current = currentTaskNote(card, note)
  return (
    hasCompletedResponse(card) &&
    card.verdict === undefined &&
    current?.status === 'verified' &&
    current.reviewReference.trim().length > 0
  )
}

export function taskBucket(card: DashboardCard, note?: DashboardTaskNote): DashboardTaskBucket {
  if (card.bucket === 'working' || card.bucket === 'attention') {
    return card.bucket
  }
  const status = currentTaskNote(card, note)?.status
  if (status === 'waiting-user') {
    return 'attention'
  }
  if (status === 'waiting-input') {
    return 'waiting-input'
  }
  if (status === undefined && (card.conversationName ?? '').startsWith('Wait/')) {
    return 'waiting-input'
  }
  return hasCompletedResponse(card) ? 'done' : card.bucket
}

export function taskStatusLabel(card: DashboardCard, note?: DashboardTaskNote): string {
  const bucket = taskBucket(card, note)
  if (card.verdict === 'failed') {
    return translate('dashboardPopout.task.failed', 'Agent reported a failure')
  }
  if (card.verdict === 'interrupted') {
    return translate('dashboardPopout.task.interrupted', 'Agent was stopped')
  }
  if (card.verdict === 'unconfirmed') {
    return translate('dashboardPopout.task.unconfirmed', 'Response could not be confirmed')
  }
  if (taskResultVerified(card, note)) {
    return translate('dashboardPopout.task.verified', 'Result verified')
  }
  if (bucket === 'attention') {
    return translate('dashboardPopout.task.needsYou', 'Waiting for you')
  }
  if (bucket === 'waiting-input') {
    return translate('dashboardPopout.task.waitingInput', 'Waiting for input')
  }
  if (bucket === 'working') {
    return translate('dashboardPopout.task.working', 'Agent is working')
  }
  if (bucket === 'done') {
    return translate('dashboardPopout.task.responded', 'Responded · not reviewed')
  }
  return translate('dashboardPopout.task.idle', 'No activity reported')
}

export function taskNextStep(card: DashboardCard, note?: DashboardTaskNote): string {
  const current = currentTaskNote(card, note)
  if (current?.nextStep.trim()) {
    return current.nextStep
  }
  switch (taskBucket(card, note)) {
    case 'attention':
      return translate(
        'dashboardPopout.task.answer',
        'Open the conversation and answer the pending question.'
      )
    case 'waiting-input':
      return translate(
        'dashboardPopout.task.nameInput',
        'Specify the missing input and who will provide it.'
      )
    case 'done':
      return taskResultVerified(card, note)
        ? translate('dashboardPopout.task.reviewRecorded', 'Review recorded; add any follow-up.')
        : translate(
            'dashboardPopout.task.reviewResponse',
            'Review the response and record the outcome.'
          )
    case 'working':
      return translate('dashboardPopout.task.awaitResponse', 'Await the next response.')
    case 'idle':
      return translate(
        'dashboardPopout.task.checkConversation',
        'Check the conversation before assigning more work.'
      )
  }
}

export function isOlderResponse(
  card: DashboardCard,
  note: DashboardTaskNote | undefined,
  now: number
): boolean {
  return (
    taskBucket(card, note) === 'done' &&
    card.finishedAt !== null &&
    card.finishedAt > 0 &&
    now - card.finishedAt >= RECENT_RESPONSE_MS
  )
}

export function readTaskNote(raw: string | null): DashboardTaskNote | undefined {
  if (!raw) {
    return undefined
  }
  try {
    const result = taskNoteSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}
