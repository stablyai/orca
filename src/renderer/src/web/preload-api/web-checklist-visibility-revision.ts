import { createBrowserUuid } from '@/lib/browser-uuid'
import { readJson, writeJson } from './web-storage'

const CHECKLIST_VISIBILITY_REVISION_KEY = 'orca.web.checklistVisibilityRevision.v1'

type RevisionOperation = {
  id: string
  issuedAt: number
  kind: 'observation' | 'write'
}

type AppliedRevision = { id: string; issuedAt: number }

type ChecklistVisibilityRevision = {
  observation: string
  operation: RevisionOperation | null
  appliedWrite: AppliedRevision | null
  acceptedValue?: boolean
}

export type ChecklistVisibilityObservation = RevisionOperation
type ChecklistVisibilityWrite = { observation: string; write: string; issuedAt: number }

function freshRevision(acceptedValue?: boolean): ChecklistVisibilityRevision {
  return {
    observation: createBrowserUuid(),
    operation: null,
    appliedWrite: null,
    ...(typeof acceptedValue === 'boolean' ? { acceptedValue } : {})
  }
}

function readRevision(): ChecklistVisibilityRevision {
  const revision = readJson<ChecklistVisibilityRevision>(CHECKLIST_VISIBILITY_REVISION_KEY, {
    observation: 'initial',
    operation: null,
    appliedWrite: null
  })
  if (
    typeof revision.observation !== 'string' ||
    revision.observation.length === 0 ||
    (revision.operation !== null &&
      (typeof revision.operation?.id !== 'string' ||
        !Number.isFinite(revision.operation?.issuedAt) ||
        (revision.operation?.kind !== 'observation' && revision.operation?.kind !== 'write'))) ||
    (revision.appliedWrite !== null &&
      (typeof revision.appliedWrite?.id !== 'string' ||
        !Number.isFinite(revision.appliedWrite?.issuedAt))) ||
    (revision.acceptedValue !== undefined && typeof revision.acceptedValue !== 'boolean')
  ) {
    const fresh = freshRevision()
    writeJson(CHECKLIST_VISIBILITY_REVISION_KEY, fresh)
    return fresh
  }
  return revision
}

function now(): number {
  return performance.timeOrigin + performance.now()
}

function isAfter(candidate: AppliedRevision, current: AppliedRevision | null): boolean {
  return (
    !current ||
    candidate.issuedAt > current.issuedAt ||
    (candidate.issuedAt === current.issuedAt && candidate.id > current.id)
  )
}

/** Marks a host read at dispatch so a delayed response cannot replace a later checklist save. */
export function beginChecklistVisibilityObservation(): ChecklistVisibilityObservation {
  const observation = { id: createBrowserUuid(), issuedAt: now(), kind: 'observation' as const }
  const revision = readRevision()
  writeJson(CHECKLIST_VISIBILITY_REVISION_KEY, {
    ...revision,
    operation: isAfter(observation, revision.operation) ? observation : revision.operation
  })
  return observation
}

/** Records a successful host observation and keeps its value recoverable if the UI cache write fails. */
export function acceptChecklistVisibilityObservation(
  observation: ChecklistVisibilityObservation,
  value: boolean | undefined
): boolean {
  if (typeof value !== 'boolean') {
    cancelChecklistVisibilityObservation(observation)
    return false
  }
  const revision = readRevision()
  if (revision.operation?.id !== observation.id) {
    return false
  }
  writeJson(CHECKLIST_VISIBILITY_REVISION_KEY, {
    ...freshRevision(value),
    appliedWrite: { id: observation.id, issuedAt: observation.issuedAt }
  })
  return true
}

/** Releases an observation that failed or came from a host without checklist support. */
export function cancelChecklistVisibilityObservation(
  observation: ChecklistVisibilityObservation
): void {
  const revision = readRevision()
  if (revision.operation?.id === observation.id) {
    writeJson(CHECKLIST_VISIBILITY_REVISION_KEY, { ...revision, operation: null })
  }
}

/** A local-only checklist choice invalidates in-flight observations and is immediately recoverable. */
export function advanceChecklistVisibilityRevision(value: boolean | undefined): void {
  if (typeof value === 'boolean') {
    writeJson(CHECKLIST_VISIBILITY_REVISION_KEY, freshRevision(value))
  }
}

/** Gives every attempt a unique ordering token, including writes started in separate browser tabs. */
export function beginChecklistVisibilityWrite(
  value: boolean | undefined
): ChecklistVisibilityWrite | null {
  if (typeof value !== 'boolean') {
    return null
  }
  const write = createBrowserUuid()
  const issuedAt = now()
  const revision = readRevision()
  const attempt = { observation: revision.observation, write, issuedAt }
  writeJson(CHECKLIST_VISIBILITY_REVISION_KEY, {
    ...revision,
    operation: isAfter({ id: attempt.write, issuedAt: attempt.issuedAt }, revision.operation)
      ? { id: attempt.write, issuedAt: attempt.issuedAt, kind: 'write' }
      : revision.operation
  })
  return attempt
}

/** Keeps the newest successful save while allowing an older success through when a later save fails. */
export function acceptChecklistVisibilityWrite(
  attempt: ChecklistVisibilityWrite | null,
  value: boolean
): boolean {
  if (!attempt) {
    return false
  }
  const revision = readRevision()
  if (attempt.observation !== revision.observation) {
    return false
  }
  const applied = { id: attempt.write, issuedAt: attempt.issuedAt }
  if (!isAfter(applied, revision.appliedWrite)) {
    return false
  }
  writeJson(CHECKLIST_VISIBILITY_REVISION_KEY, {
    ...revision,
    appliedWrite: applied,
    acceptedValue: value
  })
  return true
}

export function readAcceptedChecklistVisibility(): boolean | undefined {
  return readRevision().acceptedValue
}
