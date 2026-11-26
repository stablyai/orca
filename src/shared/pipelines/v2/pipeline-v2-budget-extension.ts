import type { PipelineV2RunSummary } from './pipeline-v2-public-results'

export function pipelineBudgetExtension(
  run: Pick<PipelineV2RunSummary, 'effectiveLimits' | 'stageId' | 'currentVisitId'>,
  values: { maxInvocations: number; maxDiscussionTurns: number; maxReentries: number }
) {
  const limits = run.effectiveLimits
  return {
    ...(values.maxInvocations > limits.maxInvocations
      ? { maxInvocations: values.maxInvocations }
      : {}),
    ...(values.maxDiscussionTurns > limits.maxDiscussionTurns
      ? { visitId: run.currentVisitId, maxDiscussionTurns: values.maxDiscussionTurns }
      : {}),
    ...(values.maxReentries > limits.maxReentries
      ? { stageId: limits.reentryStageId ?? run.stageId, maxReentries: values.maxReentries }
      : {})
  }
}
