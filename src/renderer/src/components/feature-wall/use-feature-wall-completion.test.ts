import { describe, expect, it } from 'vitest'
import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { FeatureWallWorkflowId } from '../../../../shared/feature-wall-workflows'
import type { ReviewStepId } from '../../../../shared/review-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'
import {
  normalizeFeatureWallVisitedWorkflows,
  normalizeFeatureWallVisitedAgentSteps,
  normalizeFeatureWallVisitedReviewSteps,
  normalizeFeatureWallVisitedWorkbenchSteps
} from './feature-wall-completion-persistence'
import { getFeatureWallCompletionProgress } from './feature-wall-completion-progress'

type CompletionInput = Parameters<typeof getFeatureWallCompletionProgress>[0]

function completionInput(overrides: Partial<CompletionInput> = {}): CompletionInput {
  return {
    visitedWorkflows: new Set<FeatureWallWorkflowId>(),
    visitedAgentSteps: new Set<AgentsStepId>(),
    visitedWorkbenchSteps: new Set<WorkbenchStepId>(),
    visitedReviewSteps: new Set<ReviewStepId>(),
    hasConnectedTaskSource: false,
    isCheckingTaskSources: false,
    hasUsageAccount: false,
    orchestrationSkillInstalled: false,
    browserUseSkillInstalled: false,
    githubConfigured: false,
    aiCommitPrConfigured: false,
    ...overrides
  }
}

describe('getFeatureWallCompletionProgress', () => {
  it('does not complete setup-backed items before the user visits them in the tour', () => {
    const progress = getFeatureWallCompletionProgress(
      completionInput({
        hasConnectedTaskSource: true,
        hasUsageAccount: true,
        orchestrationSkillInstalled: true,
        browserUseSkillInstalled: true,
        githubConfigured: true,
        aiCommitPrConfigured: true
      })
    )

    expect(progress.workflowDone.tasks).toBe(false)
    expect(progress.workflowDone['agents-orchestration']).toBe(false)
    expect(progress.workflowDone.workbench).toBe(false)
    expect(progress.workflowDone.review).toBe(false)
    expect(progress.agentStepDone.usage).toBe(false)
    expect(progress.workbenchStepDone.browser).toBe(false)
    expect(progress.reviewStepDone['pr-view']).toBe(false)
    expect(progress.reviewStepDone.ship).toBe(false)
  })

  it('completes tasks only after the user visits Tasks and a task source is connected', () => {
    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedWorkflows: new Set<FeatureWallWorkflowId>(['tasks'])
        })
      ).workflowDone.tasks
    ).toBe(false)

    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedWorkflows: new Set<FeatureWallWorkflowId>(['tasks']),
          hasConnectedTaskSource: true
        })
      ).workflowDone.tasks
    ).toBe(true)
  })

  it('requires both visiting orchestration and detecting the skill before completing the step', () => {
    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedAgentSteps: new Set<AgentsStepId>(['orchestration'])
        })
      ).agentStepDone.orchestration
    ).toBe(false)

    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          orchestrationSkillInstalled: true
        })
      ).agentStepDone.orchestration
    ).toBe(false)

    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedAgentSteps: new Set<AgentsStepId>(['orchestration']),
          orchestrationSkillInstalled: true
        })
      ).agentStepDone.orchestration
    ).toBe(true)
  })

  it('keeps setup-backed substeps complete after detection later reports unavailable', () => {
    const progress = getFeatureWallCompletionProgress(
      completionInput({
        completedAgentSteps: new Set<AgentsStepId>(['orchestration']),
        completedWorkbenchSteps: new Set<WorkbenchStepId>(['browser'])
      })
    )

    expect(progress.agentStepDone.orchestration).toBe(true)
    expect(progress.workbenchStepDone.browser).toBe(true)
  })

  it('keeps completed workflows complete after setup-backed detection later reports unavailable', () => {
    const progress = getFeatureWallCompletionProgress(
      completionInput({
        completedWorkflows: new Set<FeatureWallWorkflowId>(['agents-orchestration', 'workbench'])
      })
    )

    expect(progress.workflowDone['agents-orchestration']).toBe(true)
    expect(progress.workflowDone.workbench).toBe(true)
  })

  it('keeps the agents workflow incomplete until the orchestration skill is detected', () => {
    const otherwiseComplete = completionInput({
      visitedWorkflows: new Set<FeatureWallWorkflowId>(['agents-orchestration']),
      visitedAgentSteps: new Set<AgentsStepId>(['statuses', 'usage', 'orchestration']),
      hasUsageAccount: true
    })

    expect(
      getFeatureWallCompletionProgress(otherwiseComplete).workflowDone['agents-orchestration']
    ).toBe(false)
    expect(
      getFeatureWallCompletionProgress({
        ...otherwiseComplete,
        orchestrationSkillInstalled: true
      }).workflowDone['agents-orchestration']
    ).toBe(true)
  })

  it('keeps the agents workflow complete after sub-step visits are restored', () => {
    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedWorkflows: new Set<FeatureWallWorkflowId>(['agents-orchestration']),
          visitedAgentSteps: new Set<AgentsStepId>(['statuses', 'usage', 'orchestration']),
          hasUsageAccount: true,
          orchestrationSkillInstalled: true
        })
      ).workflowDone['agents-orchestration']
    ).toBe(true)
  })

  it('keeps the review workflow complete after the notes visit is restored', () => {
    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedWorkflows: new Set<FeatureWallWorkflowId>(['review']),
          visitedReviewSteps: new Set<ReviewStepId>(['notes', 'pr-view', 'ship']),
          githubConfigured: true,
          aiCommitPrConfigured: true
        })
      ).workflowDone.review
    ).toBe(true)
  })

  it('keeps the workbench workflow complete after all sub-step visits are restored', () => {
    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedWorkflows: new Set<FeatureWallWorkflowId>(['workbench']),
          visitedWorkbenchSteps: new Set<WorkbenchStepId>(['terminal', 'editor', 'browser']),
          browserUseSkillInstalled: true
        })
      ).workflowDone.workbench
    ).toBe(true)
  })

  it('requires the Browser Use skill before completing the workbench browser step', () => {
    const browserVisited = completionInput({
      visitedWorkflows: new Set<FeatureWallWorkflowId>(['workbench']),
      visitedWorkbenchSteps: new Set<WorkbenchStepId>(['terminal', 'editor', 'browser'])
    })

    expect(getFeatureWallCompletionProgress(browserVisited).workbenchStepDone.browser).toBe(false)
    expect(getFeatureWallCompletionProgress(browserVisited).workflowDone.workbench).toBe(false)

    expect(
      getFeatureWallCompletionProgress({
        ...browserVisited,
        browserUseSkillInstalled: true
      }).workbenchStepDone.browser
    ).toBe(true)
    expect(
      getFeatureWallCompletionProgress({
        ...browserVisited,
        browserUseSkillInstalled: true
      }).workflowDone.workbench
    ).toBe(true)
  })
})

describe('normalizeFeatureWallVisitedWorkflows', () => {
  it('keeps persisted workflow visits and drops duplicates or unknown ids', () => {
    expect(normalizeFeatureWallVisitedWorkflows(['workspaces', 'tasks', 'tasks', 'bogus'])).toEqual(
      ['workspaces', 'tasks']
    )
  })
})

describe('normalizeFeatureWallVisitedAgentSteps', () => {
  it('keeps persisted agents visits and drops duplicates or unknown steps', () => {
    expect(
      normalizeFeatureWallVisitedAgentSteps([
        'statuses',
        'orchestration',
        'usage',
        'orchestration',
        'notifications',
        'bogus'
      ])
    ).toEqual(['statuses', 'orchestration', 'usage'])
  })
})

describe('normalizeFeatureWallVisitedWorkbenchSteps', () => {
  it('keeps persisted workbench visits and drops duplicates or unknown steps', () => {
    expect(
      normalizeFeatureWallVisitedWorkbenchSteps([
        'terminal',
        'editor',
        'browser',
        'editor',
        'bogus'
      ])
    ).toEqual(['terminal', 'editor', 'browser'])
  })
})

describe('normalizeFeatureWallVisitedReviewSteps', () => {
  it('keeps persisted review visits and drops duplicates or unknown steps', () => {
    expect(
      normalizeFeatureWallVisitedReviewSteps(['notes', 'pr-view', 'ship', 'notes', 'bogus'])
    ).toEqual(['notes', 'pr-view', 'ship'])
  })
})
