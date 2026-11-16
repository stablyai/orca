import type { AgentsStepId } from './agents-orchestration-steps'
import type { FeatureWallWorkflowId } from './feature-wall-workflows'
import type { ReviewStepId } from './review-steps'
import type { WorkbenchStepId } from './workbench-steps'

export const FEATURE_WALL_TOUR_DEPTH_STEPS = [
  'workspaces',
  'tasks',
  'agents_statuses',
  'agents_usage',
  'agents_orchestration',
  'workbench_terminal',
  'workbench_editor',
  'workbench_browser',
  'review_notes',
  'review_pr_view',
  'review_ship'
] as const

export type FeatureWallTourDepthStep = (typeof FEATURE_WALL_TOUR_DEPTH_STEPS)[number]

export const FEATURE_WALL_EXIT_ACTIONS = ['done', 'dismissed', 'onboarding_continue'] as const

export type FeatureWallExitAction = (typeof FEATURE_WALL_EXIT_ACTIONS)[number]

export type FeatureWallTourDepthSummary = {
  furthest_step?: FeatureWallTourDepthStep
  last_group_id?: FeatureWallWorkflowId
  visited_workflow_count: number
  visited_substep_count: number
  completed_workflow_count: number
  completed_substep_count: number
}

export type FeatureWallTourDepthInput = {
  visitedWorkflows: ReadonlySet<FeatureWallWorkflowId>
  visitedAgentSteps: ReadonlySet<AgentsStepId>
  visitedWorkbenchSteps: ReadonlySet<WorkbenchStepId>
  visitedReviewSteps: ReadonlySet<ReviewStepId>
  workflowDone: Record<FeatureWallWorkflowId, boolean>
  agentStepDone: Record<AgentsStepId, boolean>
  workbenchStepDone: Record<WorkbenchStepId, boolean>
  reviewStepDone: Record<ReviewStepId, boolean>
  lastGroupId: FeatureWallWorkflowId | null
}

const DEPTH_STEP_RANK = new Map<FeatureWallTourDepthStep, number>(
  FEATURE_WALL_TOUR_DEPTH_STEPS.map((step, index) => [step, index])
)

const AGENT_DEPTH_STEP: Record<AgentsStepId, FeatureWallTourDepthStep> = {
  statuses: 'agents_statuses',
  usage: 'agents_usage',
  orchestration: 'agents_orchestration'
}

const WORKBENCH_DEPTH_STEP: Record<WorkbenchStepId, FeatureWallTourDepthStep> = {
  terminal: 'workbench_terminal',
  editor: 'workbench_editor',
  browser: 'workbench_browser'
}

const REVIEW_DEPTH_STEP: Record<ReviewStepId, FeatureWallTourDepthStep> = {
  notes: 'review_notes',
  'pr-view': 'review_pr_view',
  ship: 'review_ship'
}

function getFurthestDepthStep(
  steps: Iterable<FeatureWallTourDepthStep>
): FeatureWallTourDepthStep | undefined {
  let furthest: FeatureWallTourDepthStep | undefined
  let furthestRank = -1
  for (const step of steps) {
    const rank = DEPTH_STEP_RANK.get(step) ?? -1
    if (rank > furthestRank) {
      furthest = step
      furthestRank = rank
    }
  }
  return furthest
}

export function getFeatureWallTourDepthStep(input: {
  workflowId: FeatureWallWorkflowId
  agentStepId?: AgentsStepId
  workbenchStepId?: WorkbenchStepId
  reviewStepId?: ReviewStepId
}): FeatureWallTourDepthStep {
  if (input.workflowId === 'agents-orchestration') {
    return AGENT_DEPTH_STEP[input.agentStepId ?? 'statuses']
  }
  if (input.workflowId === 'workbench') {
    return WORKBENCH_DEPTH_STEP[input.workbenchStepId ?? 'terminal']
  }
  if (input.workflowId === 'review') {
    return REVIEW_DEPTH_STEP[input.reviewStepId ?? 'notes']
  }
  return input.workflowId
}

export function buildFeatureWallTourDepthSummary(
  input: FeatureWallTourDepthInput
): FeatureWallTourDepthSummary {
  const visitedDepthSteps = [
    ...(input.visitedWorkflows.has('workspaces') ? (['workspaces'] as const) : []),
    ...(input.visitedWorkflows.has('tasks') ? (['tasks'] as const) : []),
    ...[...input.visitedAgentSteps].map((step) => AGENT_DEPTH_STEP[step]),
    ...[...input.visitedWorkbenchSteps].map((step) => WORKBENCH_DEPTH_STEP[step]),
    ...[...input.visitedReviewSteps].map((step) => REVIEW_DEPTH_STEP[step])
  ]
  const furthestStep = getFurthestDepthStep(visitedDepthSteps)
  return {
    ...(furthestStep ? { furthest_step: furthestStep } : {}),
    ...(input.lastGroupId ? { last_group_id: input.lastGroupId } : {}),
    visited_workflow_count: input.visitedWorkflows.size,
    visited_substep_count:
      input.visitedAgentSteps.size +
      input.visitedWorkbenchSteps.size +
      input.visitedReviewSteps.size,
    completed_workflow_count: Object.values(input.workflowDone).filter(Boolean).length,
    completed_substep_count:
      Object.values(input.agentStepDone).filter(Boolean).length +
      Object.values(input.workbenchStepDone).filter(Boolean).length +
      Object.values(input.reviewStepDone).filter(Boolean).length
  }
}
