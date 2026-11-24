import type { PipelineV2Definition, PipelineV2Template } from './pipeline-v2-contracts'

type Policy = PipelineV2Template['completionPolicy']
type Requirement = Extract<Policy, { kind: 'reviewed_source' }>['reviewRequirements'][number]

export function pipelineV2ReviewRequirements(requirement: Requirement) {
  return {
    independent: requirement.independent ?? true,
    freshSession: requirement.freshSession ?? true
  }
}

export function pipelineV2RequiresReviewCommit(
  definition: Pick<PipelineV2Definition, 'completionPolicy'>,
  stage: PipelineV2Definition['stages'][number]
): boolean {
  return (
    stage.kind === 'agent' &&
    (stage.independent ||
      (definition.completionPolicy.kind === 'reviewed_source' &&
        definition.completionPolicy.reviewRequirements.some((value) => value.stageId === stage.id)))
  )
}
