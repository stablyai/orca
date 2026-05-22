import { describe, expect, it } from 'vitest'
import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { FeatureWallWorkflowId } from '../../../../shared/feature-wall-workflows'
import type { ReviewStepId } from '../../../../shared/review-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'
import {
  getFeatureWallCompletionProgress,
  normalizeFeatureWallVisitedAgentSteps,
  normalizeFeatureWallVisitedReviewSteps
} from './use-feature-wall-completion'

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
    notificationsConfigured: false,
    githubConfigured: false,
    aiCommitPrConfigured: false,
    ...overrides
  }
}

describe('getFeatureWallCompletionProgress', () => {
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

  it('keeps the agents workflow incomplete until the orchestration skill is detected', () => {
    const otherwiseComplete = completionInput({
      visitedAgentSteps: new Set<AgentsStepId>(['statuses', 'orchestration']),
      hasUsageAccount: true,
      notificationsConfigured: true
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

  it('keeps the review workflow complete after the notes visit is restored', () => {
    expect(
      getFeatureWallCompletionProgress(
        completionInput({
          visitedReviewSteps: new Set<ReviewStepId>(['notes']),
          githubConfigured: true,
          aiCommitPrConfigured: true
        })
      ).workflowDone.review
    ).toBe(true)
  })
})

describe('normalizeFeatureWallVisitedAgentSteps', () => {
  it('keeps persisted orchestration visits and drops transient or unknown steps', () => {
    expect(
      normalizeFeatureWallVisitedAgentSteps([
        'statuses',
        'orchestration',
        'usage',
        'orchestration',
        'bogus'
      ])
    ).toEqual(['orchestration'])
  })
})

describe('normalizeFeatureWallVisitedReviewSteps', () => {
  it('keeps persisted review notes visits and drops setup-backed or unknown steps', () => {
    expect(
      normalizeFeatureWallVisitedReviewSteps(['notes', 'pr-view', 'ship', 'notes', 'bogus'])
    ).toEqual(['notes'])
  })
})
