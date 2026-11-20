import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PIPELINE_CONFIG,
  parsePipelineConfigText,
  validatePipelineConfig,
  type PipelineConfig
} from './pipeline-config'
import { advancePipelineRun, createPipelineRun } from './pipeline-run'

const CUSTOM: PipelineConfig = {
  version: 1,
  initial: 'triage',
  stages: [
    { id: 'triage', on: { 'triaged:auto': { goto: 'merge' } } },
    { id: 'merge', on: { merged: { goto: null } } }
  ]
}

describe('pipeline-run', () => {
  it('starts at the configured initial stage', () => {
    expect(createPipelineRun(CUSTOM, 'issue-1')).toEqual({
      issueId: 'issue-1',
      stages: { triage: 'active', merge: 'idle' },
      completed: false
    })
  })

  it('runs a custom two-stage pipeline to completion', () => {
    let run = createPipelineRun(CUSTOM, 'issue-1')
    run = advancePipelineRun(CUSTOM, run, { type: 'triaged:auto' })
    expect(run.stages).toEqual({ triage: 'pass', merge: 'active' })
    run = advancePipelineRun(CUSTOM, run, { type: 'merged' })
    expect(run).toEqual({
      issueId: 'issue-1',
      stages: { triage: 'pass', merge: 'pass' },
      completed: true
    })
  })

  it('ignores unknown events and freezes completed runs', () => {
    let run = createPipelineRun(CUSTOM, 'issue-1')
    expect(advancePipelineRun(CUSTOM, run, { type: 'merged' })).toBe(run)
    run = advancePipelineRun(CUSTOM, run, { type: 'triaged:auto' })
    run = advancePipelineRun(CUSTOM, run, { type: 'merged' })
    expect(advancePipelineRun(CUSTOM, run, { type: 'triaged:auto' })).toBe(run)
  })

  it('runs the default six stages with approval and rework loops', () => {
    const config = DEFAULT_PIPELINE_CONFIG
    let run = createPipelineRun(config, 'issue-9')
    run = advancePipelineRun(config, run, { type: 'triaged:manual' })
    expect(run.stages).toMatchObject({ triage: 'pass', approval: 'active' })
    run = advancePipelineRun(config, run, { type: 'approved' })
    run = advancePipelineRun(config, run, { type: 'fix:completed' })
    run = advancePipelineRun(config, run, { type: 'review:changes-requested' })
    expect(run.stages).toMatchObject({ review: 'attention', fix: 'active' })
    run = advancePipelineRun(config, run, { type: 'fix:completed' })
    run = advancePipelineRun(config, run, { type: 'review:passed' })
    run = advancePipelineRun(config, run, { type: 'ci:failed' })
    expect(run.stages).toMatchObject({ ci: 'attention', fix: 'active' })
    run = advancePipelineRun(config, run, { type: 'fix:completed' })
    run = advancePipelineRun(config, run, { type: 'review:passed' })
    run = advancePipelineRun(config, run, { type: 'ci:passed' })
    run = advancePipelineRun(config, run, { type: 'merged' })
    expect(run.completed).toBe(true)
    expect(run.stages.merge).toBe('pass')
  })

  it('rejects configs with unknown targets and bad versions', () => {
    expect(
      validatePipelineConfig({ version: 2, initial: 'a', stages: [{ id: 'a', on: {} }] })
    ).toEqual(['pipeline config version must be 1'])
    expect(
      validatePipelineConfig({
        version: 1,
        initial: 'a',
        stages: [{ id: 'a', on: { go: { goto: 'missing' } } }]
      })
    ).toEqual(['stage a event go points at unknown stage missing'])
    expect(() => parsePipelineConfigText('{"version":1,"initial":"a","stages":[]}')).toThrow(
      'at least one stage'
    )
  })
})
