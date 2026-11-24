import { pipelineV2Fingerprint } from './pipeline-v2-fingerprint'
import {
  PipelineV2Template,
  type PipelineV2CompiledStage,
  type PipelineV2Definition
} from './pipeline-v2-contracts'
import { pipelineV2SerializedBytes } from './pipeline-v2-values'
import { pipelineV2ReviewRequirements } from './pipeline-v2-review-policy'

function validateStages(template: PipelineV2Template): void {
  const stages = new Map(template.stages.map((stage) => [stage.id, stage]))
  if (stages.size !== template.stages.length) {
    throw new Error('pipeline_duplicate_stage')
  }
  if (template.entryStageId !== template.stages[0].id) {
    throw new Error('pipeline_entry_stage_invalid')
  }
  for (const stage of template.stages) {
    const outcomes = new Set(stage.outcomes.map((value) => value.id))
    if (outcomes.size !== stage.outcomes.length) {
      throw new Error('pipeline_duplicate_outcome')
    }
    if (
      !stages.has(stage.ownerGate.reworkTargetStageId) ||
      stage.inputs.stageIds.some((id) => !stages.has(id)) ||
      stage.outcomes.some(
        (outcome) => outcome.target.kind === 'stage' && !stages.has(outcome.target.stageId)
      )
    ) {
      throw new Error('pipeline_invalid_target')
    }
    if (stage.kind === 'checks') {
      const map = stage.checkOutcomeMap
      if (
        outcomes.size !== 2 ||
        map.passed === map.failed ||
        !outcomes.has(map.passed) ||
        !outcomes.has(map.failed) ||
        new Set(stage.executor.checkIds).size !== stage.executor.checkIds.length
      ) {
        throw new Error('pipeline_check_outcome_map')
      }
    } else if (stage.independent && stage.executor.session.kind === 'reuse') {
      const groupId = stage.executor.session.groupId
      if (
        template.stages.some(
          (other) =>
            other.kind === 'agent' &&
            other.id !== stage.id &&
            !other.independent &&
            other.executor.session.kind === 'reuse' &&
            other.executor.session.groupId === groupId
        )
      ) {
        throw new Error('pipeline_review_not_independent')
      }
    }
  }
}

function validateCompletion(template: PipelineV2Template): void {
  const policy = template.completionPolicy
  if (policy.kind === 'workflow_complete') {
    return
  }
  const stages = new Map(template.stages.map((stage) => [stage.id, stage]))
  if (!stages.has(policy.repairEntryStageId)) {
    throw new Error('pipeline_invalid_target')
  }
  for (const requirement of policy.checkRequirements) {
    const stage = stages.get(requirement.stageId)
    if (
      stage?.kind !== 'checks' ||
      requirement.checkIds.some((id) => !stage.executor.checkIds.includes(id))
    ) {
      throw new Error('pipeline_check_requirement')
    }
  }
  for (const requirement of policy.reviewRequirements) {
    const stage = stages.get(requirement.stageId)
    const required = pipelineV2ReviewRequirements(requirement)
    if (
      required.freshSession &&
      stage?.kind === 'agent' &&
      stage.executor.session.kind !== 'fresh'
    ) {
      throw new Error('pipeline_review_not_independent')
    }
    if (
      stage?.kind !== 'agent' ||
      stage.evidenceSchema !== 'review' ||
      (required.independent && !stage.independent) ||
      requirement.acceptedOutcomeIds.some(
        (id) => !stage.outcomes.some((outcome) => outcome.id === id)
      )
    ) {
      throw new Error('pipeline_review_requirement')
    }
  }
}

function validateRoutes(template: PipelineV2Template, stages: PipelineV2CompiledStage[]): void {
  const edges = new Map<string, string[]>()
  const finishing = new Set<string>()
  for (const stage of stages) {
    const targets = stage.outcomes.flatMap(({ target }) =>
      target.kind === 'stage' ? [target.stageId] : []
    )
    if (stage.ownerGate.enabled) {
      targets.push(stage.ownerGate.reworkTargetStageId)
    }
    if (stage.outcomes.some(({ target }) => target.kind === 'finish')) {
      finishing.add(stage.id)
      if (template.completionPolicy.kind === 'reviewed_source') {
        targets.push(template.completionPolicy.repairEntryStageId)
      }
    }
    edges.set(stage.id, targets)
  }
  const reachable = new Set<string>()
  const pending = [template.entryStageId]
  while (pending.length) {
    const id = pending.pop()!
    if (reachable.has(id)) {
      continue
    }
    reachable.add(id)
    pending.push(...(edges.get(id) ?? []))
  }
  if (reachable.size !== stages.length) {
    throw new Error('pipeline_unreachable_stage')
  }
  let expanded = true
  while (expanded) {
    expanded = false
    for (const [id, targets] of edges) {
      if (!finishing.has(id) && targets.some((target) => finishing.has(target))) {
        finishing.add(id)
        expanded = true
      }
    }
  }
  if (finishing.size !== stages.length) {
    throw new Error('pipeline_no_finish_path')
  }
}

export function compilePipelineV2(input: unknown): PipelineV2Definition {
  const parsed = PipelineV2Template.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues.find((value) => value.message.startsWith('pipeline_'))
    throw new Error(issue?.message ?? 'pipeline_definition_invalid')
  }
  const template = parsed.data
  if (pipelineV2SerializedBytes(template) > 256 * 1024) {
    throw new Error('pipeline_definition_budget')
  }
  validateStages(template)
  validateCompletion(template)
  const stages: PipelineV2CompiledStage[] = template.stages.map((stage, index) => ({
    ...stage,
    outcomes: stage.outcomes.map((outcome) => ({
      ...outcome,
      target:
        outcome.target.kind === 'next'
          ? template.stages[index + 1]
            ? { kind: 'stage', stageId: template.stages[index + 1].id }
            : { kind: 'finish' }
          : outcome.target
    }))
  }))
  validateRoutes(template, stages)
  const definition = { ...template, engineVersion: 2 as const, stages }
  const digest = pipelineV2Fingerprint(definition)
  const compiled = { ...definition, digest }
  if (pipelineV2SerializedBytes(compiled) > 256 * 1024) {
    throw new Error('pipeline_definition_budget')
  }
  return compiled
}
