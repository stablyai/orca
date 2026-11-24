import type { PipelineV2Stage, PipelineV2Template } from './pipeline-v2-contracts'

export function pipelineV2AgentStage(id: string): PipelineV2Stage {
  return {
    id,
    title: id,
    kind: 'agent',
    instructions: `Perform ${id}`,
    expectedResult: 'An explained result',
    executor: {
      agent: 'codex',
      model: { kind: 'explicit', id: 'fixture-model-a' },
      effort: 'high',
      surface: 'chat',
      session: { kind: 'fresh' }
    },
    evidenceSchema: 'generic',
    independent: false,
    inputs: { task: true, stageIds: [] },
    ownerGate: { enabled: false, reworkTargetStageId: id },
    maxReentries: 2,
    outcomes: [
      { id: 'done', title: 'Done', criterion: 'Result is complete', target: { kind: 'next' } }
    ]
  }
}

export function pipelineV2TemplateFixture(): PipelineV2Template {
  const review = pipelineV2AgentStage('review')
  review.outcomes = [
    { id: 'approved', title: 'Approved', criterion: 'No defects', target: { kind: 'finish' } },
    {
      id: 'changes',
      title: 'Rework',
      criterion: 'The approach needs changes',
      target: { kind: 'stage', stageId: 'plan' }
    }
  ]
  return {
    schemaVersion: 2,
    id: 'development',
    projectId: 'project-1',
    version: '1',
    title: 'Development',
    description: '',
    entryStageId: 'plan',
    stages: [pipelineV2AgentStage('plan'), pipelineV2AgentStage('implement'), review],
    limits: { maxInvocations: 128, maxDiscussionTurns: 32 },
    completionPolicy: { kind: 'workflow_complete' }
  }
}

export function pipelineV2ReviewedFixture(): PipelineV2Template {
  const template = pipelineV2TemplateFixture()
  const check = pipelineV2AgentStage('checks')
  template.stages.splice(2, 0, {
    id: check.id,
    title: check.title,
    kind: 'checks',
    instructions: '',
    expectedResult: check.expectedResult,
    executor: { checkIds: ['unit'] },
    inputs: check.inputs,
    ownerGate: check.ownerGate,
    maxReentries: 2,
    checkOutcomeMap: { passed: 'green', failed: 'red' },
    outcomes: [
      { id: 'green', title: 'Passed', criterion: 'All checks passed', target: { kind: 'next' } },
      {
        id: 'red',
        title: 'Failed',
        criterion: 'A check failed',
        target: { kind: 'stage', stageId: 'implement' }
      }
    ]
  })
  const review = template.stages[3]
  if (review.kind === 'agent') {
    review.evidenceSchema = 'review'
    review.independent = true
  }
  template.completionPolicy = {
    kind: 'reviewed_source',
    checkRequirements: [{ stageId: 'checks', checkIds: ['unit'] }],
    reviewRequirements: [{ stageId: 'review', acceptedOutcomeIds: ['approved'] }],
    repairEntryStageId: 'checks'
  }
  return template
}
