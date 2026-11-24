import { describe, expect, it } from 'vitest'
import { compilePipelineV2 } from './pipeline-v2-compiler'
import { PipelineV2Definition } from './pipeline-v2-contracts'
import { pipelineV2Fingerprint } from './pipeline-v2-fingerprint'
import {
  pipelineV2AgentStage,
  pipelineV2ReviewedFixture,
  pipelineV2TemplateFixture
} from './pipeline-v2.test-fixture'

describe('configurable pipeline definitions', () => {
  it('preserves the pinned legacy reviewed-source definition digest without materializing policy defaults', () => {
    const definition = compilePipelineV2(pipelineV2ReviewedFixture())
    expect(definition.digest).toBe(
      '0f47d38519ca09025bf0f247610d7aabc22442aaa7d871669d109c3c5088b9c1'
    )
    expect(definition.completionPolicy).toEqual({
      kind: 'reviewed_source',
      checkRequirements: [{ stageId: 'checks', checkIds: ['unit'] }],
      reviewRequirements: [{ stageId: 'review', acceptedOutcomeIds: ['approved'] }],
      repairEntryStageId: 'checks'
    })
  })
  it('permits shared-session review only under explicit completion requirements', () => {
    const template = pipelineV2ReviewedFixture()
    const review = template.stages[3]
    if (review.kind !== 'agent' || template.completionPolicy.kind !== 'reviewed_source') {
      throw new Error('Expected reviewed fixture')
    }
    review.independent = false
    review.executor.session = { kind: 'reuse', groupId: 'primary' }
    expect(() => compilePipelineV2(template)).toThrow()
    template.completionPolicy.reviewRequirements[0] = {
      stageId: 'review',
      acceptedOutcomeIds: ['approved'],
      independent: false,
      freshSession: false
    }
    expect(compilePipelineV2(template).completionPolicy).toEqual({
      kind: 'reviewed_source',
      checkRequirements: [{ stageId: 'checks', checkIds: ['unit'] }],
      reviewRequirements: [
        {
          stageId: 'review',
          acceptedOutcomeIds: ['approved'],
          independent: false,
          freshSession: false
        }
      ],
      repairEntryStageId: 'checks'
    })
    template.completionPolicy.reviewRequirements[0].independent = true
    expect(() => compilePipelineV2(template)).toThrow('pipeline_review_requirement')
  })
  it('binds the snapshot bytes with a portable fingerprint that survives schema parsing', () => {
    const compiled = compilePipelineV2(pipelineV2TemplateFixture())
    const { digest, ...body } = PipelineV2Definition.parse(compiled)
    expect(digest).toBe('539880958c1859ab22fb6e136dcf7ead61afb4219d1604014cf7ea3cf576879d')
    expect(pipelineV2Fingerprint(body)).toBe(
      '539880958c1859ab22fb6e136dcf7ead61afb4219d1604014cf7ea3cf576879d'
    )
  })
  it('compiles next while preserving an explicit return to a previous stage', () => {
    const compiled = compilePipelineV2(pipelineV2TemplateFixture())
    expect(compiled.stages[0].outcomes[0].target).toEqual({ kind: 'stage', stageId: 'implement' })
    expect(compiled.stages[1].outcomes[0].target).toEqual({ kind: 'stage', stageId: 'review' })
    expect(compiled.stages[2].outcomes[1].target).toEqual({ kind: 'stage', stageId: 'plan' })
  })

  it('reordering changes next but keeps the explicit target attached to its stable ID', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[2].outcomes[0].target = { kind: 'next' }
    template.stages = [template.stages[0], template.stages[2], template.stages[1]]
    const compiled = compilePipelineV2(template)
    expect(compiled.stages[0].outcomes[0].target).toEqual({ kind: 'stage', stageId: 'review' })
    expect(compiled.stages[1].outcomes[1].target).toEqual({ kind: 'stage', stageId: 'plan' })
    expect(compiled.stages[2].outcomes[0].target).toEqual({ kind: 'finish' })
  })

  it('rejects a missing transition target instead of silently finishing', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[2].outcomes[1].target = { kind: 'stage', stageId: 'missing' }
    expect(() => compilePipelineV2(template)).toThrow('pipeline_invalid_target')
  })

  it('rejects duplicate stage identities', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[1].id = 'plan'
    expect(() => compilePipelineV2(template)).toThrow('pipeline_duplicate_stage')
  })

  it('rejects ambiguous outcome identities within a stage', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[2].outcomes[1].id = 'approved'
    expect(() => compilePipelineV2(template)).toThrow('pipeline_duplicate_outcome')
  })

  it('rejects an unreachable stage even when it could finish on its own', () => {
    const template = pipelineV2TemplateFixture()
    const unreachable = pipelineV2AgentStage('unreachable')
    unreachable.outcomes[0].target = { kind: 'finish' }
    template.stages.push(unreachable)
    expect(() => compilePipelineV2(template)).toThrow('pipeline_unreachable_stage')
  })

  it('rejects a cycle with no possible exit', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[2].outcomes[0].target = { kind: 'stage', stageId: 'plan' }
    expect(() => compilePipelineV2(template)).toThrow('pipeline_no_finish_path')
  })

  it('rejects a reachable trap even if another branch can finish', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[2].outcomes[1].target = { kind: 'stage', stageId: 'trap' }
    const trap = pipelineV2AgentStage('trap')
    trap.outcomes[0].target = { kind: 'stage', stageId: 'trap' }
    template.stages.push(trap)
    expect(() => compilePipelineV2(template)).toThrow('pipeline_no_finish_path')
  })

  it('bounds serialized instruction input rather than silently trimming escapes', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[0].instructions = '\\'.repeat(3100)
    expect(() => compilePipelineV2(template)).toThrow('pipeline_instruction_budget')
  })

  it('bounds the UTF-8 definition size when many individually valid criteria are supplied', () => {
    const template = pipelineV2TemplateFixture()
    template.stages = Array.from({ length: 32 }, (_, i) => {
      const stage = pipelineV2AgentStage(`stage-${i}`)
      stage.instructions = 'a'.repeat(4000)
      stage.outcomes = Array.from({ length: 8 }, (_, outcome) => ({
        id: `outcome-${outcome}`,
        title: 'Result',
        criterion: 'Ж'.repeat(500),
        target: { kind: 'next' as const }
      }))
      return stage
    })
    template.entryStageId = 'stage-0'
    expect(() => compilePipelineV2(template)).toThrow('pipeline_definition_budget')
  })

  it('keeps pass and fail check categories mapped to distinct configured outcomes', () => {
    const template = pipelineV2ReviewedFixture()
    const checks = template.stages[2]
    if (checks.kind !== 'checks') {
      throw new Error('Expected checks fixture')
    }
    checks.checkOutcomeMap.failed = 'green'
    expect(() => compilePipelineV2(template)).toThrow('pipeline_check_outcome_map')
  })

  it('does not accept generic evidence as required independent review', () => {
    const template = pipelineV2ReviewedFixture()
    const review = template.stages[3]
    if (review.kind !== 'agent') {
      throw new Error('Expected review fixture')
    }
    review.evidenceSchema = 'generic'
    expect(() => compilePipelineV2(template)).toThrow('pipeline_review_requirement')
  })

  it('does not let a required independent reviewer reuse an implementation session', () => {
    const template = pipelineV2ReviewedFixture()
    const review = template.stages[3]
    if (review.kind !== 'agent') {
      throw new Error('Expected review fixture')
    }
    review.executor.session = { kind: 'reuse', groupId: 'implementation' }
    expect(() => compilePipelineV2(template)).toThrow('pipeline_review_not_independent')
  })

  it('rejects a successful review outcome that the configured reviewer cannot return', () => {
    const template = pipelineV2ReviewedFixture()
    if (template.completionPolicy.kind !== 'reviewed_source') {
      throw new Error('Expected policy fixture')
    }
    template.completionPolicy.reviewRequirements[0].acceptedOutcomeIds = ['missing']
    expect(() => compilePipelineV2(template)).toThrow('pipeline_review_requirement')
  })

  it('detaches the compiled snapshot from later draft edits', () => {
    const template = pipelineV2TemplateFixture()
    const compiled = compilePipelineV2(template)
    template.stages[0].instructions = 'Mutated after admission'
    template.stages[2].outcomes[1].target = { kind: 'finish' }
    expect(compiled.stages[0].instructions).toBe('Perform plan')
    expect(compiled.stages[2].outcomes[1].target).toEqual({ kind: 'stage', stageId: 'plan' })
  })

  it('does not interpret shell-shaped instructions as commands and refuses executable extras', () => {
    const template = pipelineV2TemplateFixture()
    template.stages[0].instructions = 'Explain $(touch /tmp/never-execute) literally'
    expect(compilePipelineV2(template).stages[0].instructions).toBe(
      'Explain $(touch /tmp/never-execute) literally'
    )
    expect(() => compilePipelineV2({ ...template, program: '/bin/sh' })).toThrow(
      'pipeline_definition_invalid'
    )
  })
})
