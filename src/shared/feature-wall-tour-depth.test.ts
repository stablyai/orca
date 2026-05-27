import { describe, expect, it } from 'vitest'
import type { AgentsStepId } from './agents-orchestration-steps'
import type { FeatureWallWorkflowId } from './feature-wall-workflows'
import type { ReviewStepId } from './review-steps'
import type { WorkbenchStepId } from './workbench-steps'
import {
  buildFeatureWallTourDepthSummary,
  getFeatureWallTourDepthStep
} from './feature-wall-tour-depth'

describe('feature wall tour depth summary', () => {
  it('maps workflow and nested steps to canonical depth values', () => {
    expect(getFeatureWallTourDepthStep({ workflowId: 'workspaces' })).toBe('workspaces')
    expect(
      getFeatureWallTourDepthStep({
        workflowId: 'agents-orchestration',
        agentStepId: 'usage'
      })
    ).toBe('agents_usage')
    expect(
      getFeatureWallTourDepthStep({ workflowId: 'workbench', workbenchStepId: 'browser' })
    ).toBe('workbench_browser')
    expect(getFeatureWallTourDepthStep({ workflowId: 'review', reviewStepId: 'ship' })).toBe(
      'review_ship'
    )
  })

  it('builds session-local counts and furthest step from visited sets', () => {
    expect(
      buildFeatureWallTourDepthSummary({
        visitedWorkflows: new Set<FeatureWallWorkflowId>(['workspaces', 'workbench']),
        visitedAgentSteps: new Set<AgentsStepId>(),
        visitedWorkbenchSteps: new Set<WorkbenchStepId>(['terminal', 'editor']),
        visitedReviewSteps: new Set<ReviewStepId>(),
        workflowDone: {
          workspaces: true,
          tasks: false,
          'agents-orchestration': false,
          workbench: false,
          review: false
        },
        agentStepDone: {
          statuses: false,
          usage: false,
          orchestration: false
        },
        workbenchStepDone: {
          terminal: true,
          editor: true,
          browser: false
        },
        reviewStepDone: {
          notes: false,
          'pr-view': false,
          ship: false
        },
        lastGroupId: 'workbench'
      })
    ).toEqual({
      furthest_step: 'workbench_editor',
      last_group_id: 'workbench',
      visited_workflow_count: 2,
      visited_substep_count: 2,
      completed_workflow_count: 1,
      completed_substep_count: 2
    })
  })
})
