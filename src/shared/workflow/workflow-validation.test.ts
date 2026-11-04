import { describe, expect, it } from 'vitest'
import { validateWorkflowDefinition } from './workflow-validation'
import { workflowTemplates, authenticationFeatureTemplate } from './workflow-templates-team'
import { dependency } from './workflow-template-builders'
import { parseWorkflowPreset, serializeWorkflowPresetForExport } from './workflow-preset-migration'
import { evaluateWorkflowCondition } from './workflow-condition-evaluation'
import { parseWorkflowResultBody } from './workflow-worker-result'

const codes = (input: unknown): string[] =>
  validateWorkflowDefinition(input)
    .issues.filter((issue) => issue.severity === 'error')
    .map((issue) => issue.code)

describe('workflow validation', () => {
  it('accepts every shipped template', () => {
    for (const template of workflowTemplates()) {
      expect(codes(template.definition), template.name).toEqual([])
    }
  })

  it('rejects an unbounded execution cycle but accepts the same edge as a bounded loop', () => {
    const definition = authenticationFeatureTemplate().definition
    const loop = definition.dependencies.find((edge) => edge.loop)!
    const unbounded = {
      ...definition,
      dependencies: [
        ...definition.dependencies.filter((edge) => edge !== loop),
        { ...loop, loop: null }
      ]
    }
    expect(codes(unbounded)).toContain('execution_cycle')
  })

  it('rejects a loop that points downstream', () => {
    const definition = authenticationFeatureTemplate().definition
    definition.dependencies.push({
      ...dependency('coordinator', 'reviewer', { loop: 1, condition: { kind: 'always' } })
    })
    expect(codes(definition)).toContain('loop_direction')
  })

  it('allows communication cycles, which are not execution dependencies', () => {
    const definition = authenticationFeatureTemplate().definition
    expect(
      definition.communication.some(
        (edge) => edge.source === 'reviewer' && edge.target === 'coordinator'
      )
    ).toBe(true)
    expect(codes(definition)).not.toContain('execution_cycle')
  })

  it('refuses a model the selected agent cannot launch with', () => {
    const definition = authenticationFeatureTemplate().definition
    const node = definition.nodes.find((candidate) => candidate.id === 'backend')!
    if (node.kind !== 'agent') {
      throw new Error('expected agent')
    }
    node.agent.runtime.agent = 'aider'
    node.agent.runtime.model = 'gpt-5'
    expect(codes(definition)).toContain('model_unsupported')
    node.agent.runtime.allowModelFallback = true
    expect(codes(definition)).not.toContain('model_unsupported')
  })

  it('refuses decisions on fields of a node that returns text', () => {
    const definition = authenticationFeatureTemplate().definition
    const reviewer = definition.nodes.find((candidate) => candidate.id === 'reviewer')!
    if (reviewer.kind !== 'reviewer') {
      throw new Error('expected reviewer')
    }
    reviewer.agent.prompt.outputFormat = 'text'
    expect(codes(definition)).toContain('decision_needs_json')
  })

  it('rejects communication into control nodes', () => {
    const definition = authenticationFeatureTemplate().definition
    definition.communication.push({ ...definition.communication[0], id: 'c-bad', target: 'join' })
    expect(codes(definition)).toContain('communication_endpoint')
  })
})

describe('workflow presets', () => {
  it('round-trips an export and refuses a schema from a newer Orca', () => {
    const preset = authenticationFeatureTemplate()
    const parsed = parseWorkflowPreset(JSON.parse(serializeWorkflowPresetForExport(preset).text))
    expect(parsed).toMatchObject({ ok: true, migratedFrom: null })
    expect(parseWorkflowPreset({ ...preset, schemaVersion: 99 })).toMatchObject({ ok: false })
  })

  it('redacts credential-shaped text on export', () => {
    const preset = authenticationFeatureTemplate()
    preset.definition.policies.sharedInstructions = 'token ghp_abcdefghijklmnopqrstuvwxyz0123'
    const exported = serializeWorkflowPresetForExport(preset)
    expect(exported.redactions).toBe(1)
    expect(exported.text).not.toContain('ghp_')
  })
})

describe('workflow conditions and results', () => {
  it('reads only own data fields, never prototype keys', () => {
    const subject = { outcome: 'succeeded' as const, approval: null, data: { verdict: 'Approved' } }
    expect(
      evaluateWorkflowCondition(
        { kind: 'field', path: 'verdict', op: 'equals', value: 'approved' },
        subject
      )
    ).toBe(true)
    expect(
      evaluateWorkflowCondition({ kind: 'field', path: 'constructor', op: 'exists' }, subject)
    ).toBe(false)
  })

  it('takes the last WORKFLOW_RESULT line and keeps prose as the summary', () => {
    const parsed = parseWorkflowResultBody(
      'Reviewed both.\nWORKFLOW_RESULT: {"verdict":"rejected"}'
    )
    expect(parsed).toEqual({
      summary: 'Reviewed both.',
      data: { verdict: 'rejected' },
      dataError: null
    })
    expect(parseWorkflowResultBody('WORKFLOW_RESULT: [1]').dataError).toContain('JSON object')
  })
})
