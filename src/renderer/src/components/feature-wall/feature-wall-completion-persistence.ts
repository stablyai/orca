import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import {
  FEATURE_WALL_WORKFLOW_IDS,
  type FeatureWallWorkflowId
} from '../../../../shared/feature-wall-workflows'
import type { ReviewStepId } from '../../../../shared/review-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'

const PERSISTED_WORKFLOW_IDS = new Set<FeatureWallWorkflowId>(FEATURE_WALL_WORKFLOW_IDS)
const VISITED_WORKFLOWS_STORAGE_KEY = 'orca.featureWall.visitedWorkflows.v1'
const COMPLETED_WORKFLOWS_STORAGE_KEY = 'orca.featureWall.completedWorkflows.v1'
const PERSISTED_AGENT_STEP_IDS = new Set<AgentsStepId>(['statuses', 'usage', 'orchestration'])
const VISITED_AGENT_STEPS_STORAGE_KEY = 'orca.featureWall.visitedAgentSteps.v1'
const COMPLETED_AGENT_STEPS_STORAGE_KEY = 'orca.featureWall.completedAgentSteps.v1'
const PERSISTED_WORKBENCH_STEP_IDS = new Set<WorkbenchStepId>(['terminal', 'editor', 'browser'])
const VISITED_WORKBENCH_STEPS_STORAGE_KEY = 'orca.featureWall.visitedWorkbenchSteps.v1'
const COMPLETED_WORKBENCH_STEPS_STORAGE_KEY = 'orca.featureWall.completedWorkbenchSteps.v1'
const PERSISTED_REVIEW_STEP_IDS = new Set<ReviewStepId>(['notes', 'pr-view', 'ship'])
const VISITED_REVIEW_STEPS_STORAGE_KEY = 'orca.featureWall.visitedReviewSteps.v1'
const COMPLETED_REVIEW_STEPS_STORAGE_KEY = 'orca.featureWall.completedReviewSteps.v1'

export function normalizeFeatureWallVisitedWorkflows(value: unknown): FeatureWallWorkflowId[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<FeatureWallWorkflowId>()
  for (const item of value) {
    if (typeof item === 'string' && PERSISTED_WORKFLOW_IDS.has(item as FeatureWallWorkflowId)) {
      seen.add(item as FeatureWallWorkflowId)
    }
  }
  return [...seen]
}

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

export function readPersistedVisitedWorkflows(): Set<FeatureWallWorkflowId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedWorkflows(
        JSON.parse(localStorage.getItem(VISITED_WORKFLOWS_STORAGE_KEY) ?? '[]')
      )
    )
  } catch {
    return new Set()
  }
}

export function readPersistedCompletedWorkflows(): Set<FeatureWallWorkflowId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedWorkflows(
        JSON.parse(localStorage.getItem(COMPLETED_WORKFLOWS_STORAGE_KEY) ?? '[]')
      )
    )
  } catch {
    return new Set()
  }
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

export function readPersistedCompletedAgentSteps(): Set<AgentsStepId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedAgentSteps(
        JSON.parse(localStorage.getItem(COMPLETED_AGENT_STEPS_STORAGE_KEY) ?? '[]')
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

export function readPersistedCompletedWorkbenchSteps(): Set<WorkbenchStepId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedWorkbenchSteps(
        JSON.parse(localStorage.getItem(COMPLETED_WORKBENCH_STEPS_STORAGE_KEY) ?? '[]')
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

export function readPersistedCompletedReviewSteps(): Set<ReviewStepId> {
  if (typeof localStorage === 'undefined') {
    return new Set()
  }
  try {
    return new Set(
      normalizeFeatureWallVisitedReviewSteps(
        JSON.parse(localStorage.getItem(COMPLETED_REVIEW_STEPS_STORAGE_KEY) ?? '[]')
      )
    )
  } catch {
    return new Set()
  }
}

export function persistVisitedWorkflow(id: FeatureWallWorkflowId): void {
  if (!PERSISTED_WORKFLOW_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedVisitedWorkflows()
    next.add(id)
    localStorage.setItem(VISITED_WORKFLOWS_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // localStorage can be unavailable in hardened browser contexts; completion
    // still works for the current open modal from React state.
  }
}

export function persistCompletedWorkflow(id: FeatureWallWorkflowId): void {
  if (!PERSISTED_WORKFLOW_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedCompletedWorkflows()
    next.add(id)
    localStorage.setItem(COMPLETED_WORKFLOWS_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // localStorage can be unavailable in hardened browser contexts; completion
    // still works for the current open modal from React state.
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

export function persistCompletedAgentStep(id: AgentsStepId): void {
  if (!PERSISTED_AGENT_STEP_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedCompletedAgentSteps()
    next.add(id)
    localStorage.setItem(COMPLETED_AGENT_STEPS_STORAGE_KEY, JSON.stringify([...next]))
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

export function persistCompletedWorkbenchStep(id: WorkbenchStepId): void {
  if (!PERSISTED_WORKBENCH_STEP_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedCompletedWorkbenchSteps()
    next.add(id)
    localStorage.setItem(COMPLETED_WORKBENCH_STEPS_STORAGE_KEY, JSON.stringify([...next]))
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

export function persistCompletedReviewStep(id: ReviewStepId): void {
  if (!PERSISTED_REVIEW_STEP_IDS.has(id) || typeof localStorage === 'undefined') {
    return
  }
  try {
    const next = readPersistedCompletedReviewSteps()
    next.add(id)
    localStorage.setItem(COMPLETED_REVIEW_STEPS_STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    // localStorage can be unavailable in hardened browser contexts; completion
    // still works for the current open modal from React state.
  }
}
