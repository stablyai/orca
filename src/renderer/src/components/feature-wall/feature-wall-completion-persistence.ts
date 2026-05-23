import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { ReviewStepId } from '../../../../shared/review-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'

const PERSISTED_AGENT_STEP_IDS = new Set<AgentsStepId>(['statuses', 'orchestration'])
const VISITED_AGENT_STEPS_STORAGE_KEY = 'orca.featureWall.visitedAgentSteps.v1'
const PERSISTED_WORKBENCH_STEP_IDS = new Set<WorkbenchStepId>(['terminal', 'editor', 'browser'])
const VISITED_WORKBENCH_STEPS_STORAGE_KEY = 'orca.featureWall.visitedWorkbenchSteps.v1'
const PERSISTED_REVIEW_STEP_IDS = new Set<ReviewStepId>(['notes'])
const VISITED_REVIEW_STEPS_STORAGE_KEY = 'orca.featureWall.visitedReviewSteps.v1'

export function normalizeFeatureWallVisitedAgentSteps(value: unknown): AgentsStepId[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<AgentsStepId>()
  for (const item of value) {
    if (typeof item === 'string' && PERSISTED_AGENT_STEP_IDS.has(item as AgentsStepId)) {
      seen.add(item as AgentsStepId)
    }
  }
  return [...seen]
}

export function normalizeFeatureWallVisitedWorkbenchSteps(value: unknown): WorkbenchStepId[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<WorkbenchStepId>()
  for (const item of value) {
    if (typeof item === 'string' && PERSISTED_WORKBENCH_STEP_IDS.has(item as WorkbenchStepId)) {
      seen.add(item as WorkbenchStepId)
    }
  }
  return [...seen]
}

export function normalizeFeatureWallVisitedReviewSteps(value: unknown): ReviewStepId[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<ReviewStepId>()
  for (const item of value) {
    if (typeof item === 'string' && PERSISTED_REVIEW_STEP_IDS.has(item as ReviewStepId)) {
      seen.add(item as ReviewStepId)
    }
  }
  return [...seen]
}

export function readPersistedVisitedAgentSteps(): Set<AgentsStepId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedAgentSteps(
        JSON.parse(localStorage.getItem(VISITED_AGENT_STEPS_STORAGE_KEY) ?? '[]')
      )
    )
  } catch {
    return new Set()
  }
}

export function readPersistedVisitedWorkbenchSteps(): Set<WorkbenchStepId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedWorkbenchSteps(
        JSON.parse(localStorage.getItem(VISITED_WORKBENCH_STEPS_STORAGE_KEY) ?? '[]')
      )
    )
  } catch {
    return new Set()
  }
}

export function readPersistedVisitedReviewSteps(): Set<ReviewStepId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedReviewSteps(
        JSON.parse(localStorage.getItem(VISITED_REVIEW_STEPS_STORAGE_KEY) ?? '[]')
      )
    )
  } catch {
    return new Set()
  }
}

export function persistVisitedAgentStep(id: AgentsStepId): void {
  if (!PERSISTED_AGENT_STEP_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedVisitedAgentSteps()
    next.add(id)
    localStorage.setItem(VISITED_AGENT_STEPS_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // localStorage can be unavailable in hardened browser contexts; completion
    // still works for the current open modal from React state.
  }
}

export function persistVisitedWorkbenchStep(id: WorkbenchStepId): void {
  if (!PERSISTED_WORKBENCH_STEP_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedVisitedWorkbenchSteps()
    next.add(id)
    localStorage.setItem(VISITED_WORKBENCH_STEPS_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // localStorage can be unavailable in hardened browser contexts; completion
    // still works for the current open modal from React state.
  }
}

export function persistVisitedReviewStep(id: ReviewStepId): void {
  if (!PERSISTED_REVIEW_STEP_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedVisitedReviewSteps()
    next.add(id)
    localStorage.setItem(VISITED_REVIEW_STEPS_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // localStorage can be unavailable in hardened browser contexts; completion
    // still works for the current open modal from React state.
  }
}
