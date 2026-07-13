import type {
  PtyCleanupInspection,
  PtyInactiveCleanupResult
} from '../../../../shared/pty-inactive-cleanup'
import { mayDestroyWithoutOwnerEvidence } from '../../../../shared/pty-listed-session'
import {
  buildResourceSessionBindingIndex,
  type ResourceSessionBindingInputs
} from './resource-session-bindings'
import type { DaemonSession } from './resource-usage-merge-types'

export const RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR =
  'Workspace sessions are still loading.'
export const RESOURCE_SESSION_CLEANUP_REVIEW_ERROR = 'Unable to check current terminal activity.'
export const RESOURCE_SESSION_CLEANUP_EXECUTION_ERROR = 'Unable to clean up inactive terminals.'

export type ResourceSessionCleanupReview = {
  reviewedIds: string[]
  inspections: PtyCleanupInspection[]
  inactiveIds: string[]
  activeCount: number
  unknownCount: number
  goneCount: number
}

export type ResourceSessionCleanupResult = {
  killedCount: number
  protectedCount: number
  goneCount: number
  failedCount: number
}

export type ResourceSessionCleanupErrorCode =
  | 'session-not-ready'
  | 'review-failed'
  | 'cleanup-failed'

export type ResourceSessionCleanupReviewState =
  | { phase: 'closed' }
  | { phase: 'reviewing' }
  | { phase: 'ready'; review: ResourceSessionCleanupReview }
  | { phase: 'running'; review: ResourceSessionCleanupReview }
  | {
      phase: 'completed'
      review: ResourceSessionCleanupReview
      result: ResourceSessionCleanupResult
    }
  | {
      phase: 'error'
      operation: 'review' | 'cleanup'
      code: ResourceSessionCleanupErrorCode
      review?: ResourceSessionCleanupReview
    }

export type ResourceSessionCleanupReviewDependencies = {
  listSessions: () => Promise<DaemonSession[]>
  readBindings: () => ResourceSessionBindingInputs
  inspectInactiveCleanup: (ids: string[]) => Promise<PtyCleanupInspection[]>
}

export type ResourceSessionCleanupExecutionDependencies = {
  listSessions: () => Promise<DaemonSession[]>
  readBindings: () => ResourceSessionBindingInputs
  killInactiveSessions: (ids: string[]) => Promise<PtyInactiveCleanupResult[]>
}

function requireReadyBindingIndex(readBindings: () => ResourceSessionBindingInputs) {
  const inputs = readBindings()
  if (!inputs.workspaceSessionReady) {
    throw new Error(RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR)
  }
  return buildResourceSessionBindingIndex(inputs)
}

export async function reviewResourceSessionCleanup(
  dependencies: ResourceSessionCleanupReviewDependencies
): Promise<ResourceSessionCleanupReview> {
  try {
    const sessions = await dependencies.listSessions()
    // Why: read after the async inventory so newly hydrated or rebound panes
    // are excluded using current renderer ownership, not click-time state.
    const { boundPtyIds } = requireReadyBindingIndex(dependencies.readBindings)
    const reviewedIds = sessions
      .filter((session) => !boundPtyIds.has(session.id) && mayDestroyWithoutOwnerEvidence(session))
      .map((session) => session.id)
    if (reviewedIds.length === 0) {
      return {
        reviewedIds: [],
        inspections: [],
        inactiveIds: [],
        activeCount: 0,
        unknownCount: 0,
        goneCount: 0
      }
    }
    const returned = await dependencies.inspectInactiveCleanup(reviewedIds)
    const returnedById = new Map(returned.map((inspection) => [inspection.id, inspection]))
    const inspections = reviewedIds.map(
      (id): PtyCleanupInspection => returnedById.get(id) ?? { id, safety: 'unknown' }
    )

    return {
      reviewedIds,
      inspections,
      inactiveIds: inspections
        .filter((inspection) => inspection.safety === 'inactive')
        .map((inspection) => inspection.id),
      activeCount: inspections.filter((inspection) => inspection.safety === 'active').length,
      unknownCount: inspections.filter((inspection) => inspection.safety === 'unknown').length,
      goneCount: inspections.filter((inspection) => inspection.safety === 'gone').length
    }
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR
    ) {
      throw error
    }
    throw new Error(RESOURCE_SESSION_CLEANUP_REVIEW_ERROR)
  }
}

export function getResourceSessionCleanupErrorCode(
  error: unknown,
  operation: 'review' | 'cleanup'
): ResourceSessionCleanupErrorCode {
  if (
    error instanceof Error &&
    error.message === RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR
  ) {
    return 'session-not-ready'
  }
  return operation === 'review' ? 'review-failed' : 'cleanup-failed'
}

function summarizeOutcomes(
  outcomes: PtyInactiveCleanupResult[],
  initial: Pick<ResourceSessionCleanupResult, 'protectedCount' | 'goneCount'>
): ResourceSessionCleanupResult {
  const result: ResourceSessionCleanupResult = {
    killedCount: 0,
    protectedCount: initial.protectedCount,
    goneCount: initial.goneCount,
    failedCount: 0
  }
  for (const { outcome } of outcomes) {
    if (outcome === 'killed') {
      result.killedCount += 1
    } else if (outcome === 'protected-active' || outcome === 'protected-unknown') {
      result.protectedCount += 1
    } else if (outcome === 'gone') {
      result.goneCount += 1
    } else {
      result.failedCount += 1
    }
  }
  return result
}

export async function executeResourceSessionCleanup(
  review: ResourceSessionCleanupReview,
  dependencies: ResourceSessionCleanupExecutionDependencies
): Promise<ResourceSessionCleanupResult> {
  try {
    const sessions = await dependencies.listSessions()
    const { boundPtyIds } = requireReadyBindingIndex(dependencies.readBindings)
    const liveSessionsById = new Map(sessions.map((session) => [session.id, session]))
    const reviewedIds = new Set(review.reviewedIds)
    const eligibleIds: string[] = []
    let protectedCount = 0
    let goneCount = 0

    for (const id of review.inactiveIds) {
      if (!reviewedIds.has(id)) {
        continue
      }
      const session = liveSessionsById.get(id)
      if (!session) {
        goneCount += 1
      } else if (boundPtyIds.has(id) || !mayDestroyWithoutOwnerEvidence(session)) {
        protectedCount += 1
      } else {
        eligibleIds.push(id)
      }
    }

    if (eligibleIds.length === 0) {
      return { killedCount: 0, protectedCount, goneCount, failedCount: 0 }
    }

    const returned = await dependencies.killInactiveSessions(eligibleIds)
    const returnedById = new Map(returned.map((outcome) => [outcome.id, outcome]))
    const outcomes = eligibleIds.map(
      (id): PtyInactiveCleanupResult => returnedById.get(id) ?? { id, outcome: 'failed' }
    )
    return summarizeOutcomes(outcomes, { protectedCount, goneCount })
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === RESOURCE_SESSION_CLEANUP_SESSION_NOT_READY_ERROR
    ) {
      throw error
    }
    throw new Error(RESOURCE_SESSION_CLEANUP_EXECUTION_ERROR)
  }
}
