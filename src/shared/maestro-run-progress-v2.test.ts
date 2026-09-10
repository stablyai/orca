import { describe, expect, it } from 'vitest'
import { MaestroRunProgressV2Schema } from './maestro-run-progress-v2'

const progress = {
  schema_version: 2,
  run: { id: 'run-1', title: 'Ship the deliverable' },
  execution: {
    state: 'completed',
    progress_percent: 100,
    completed: 1,
    total: 1,
    counts: {
      pending: 0,
      running: 0,
      input_required: 0,
      blocked: 0,
      succeeded: 1,
      failed: 0,
      cancelled: 0
    }
  },
  deliverables: { progress_percent: 100, completed: 1, total: 1 },
  operational_reliability: { successful: 0, failed: 0, superseded: 1, unverifiable: 0 },
  projection_health: { state: 'healthy', revision: 2 },
  cleanup_health: { state: 'clean', count: 0 },
  current: [],
  recently_completed: [
    {
      reference: 'task-setup',
      title: 'Prepare worker',
      outcome_summary: 'Replaced unavailable worker',
      purpose: 'operational',
      operational_outcome: 'superseded',
      successor_reference: 'task-replacement'
    }
  ],
  next: [],
  blocked: [],
  nested_activity: [],
  technical: {
    execution_host_id: 'local',
    workspace_key: 'folder:one',
    run_id: 'run-1',
    revision: 2
  }
} as const

describe('Maestro Run progress v2 outcomes', () => {
  it('accepts separate deliverable and superseded operational contracts', () => {
    expect(MaestroRunProgressV2Schema.parse(progress)).toEqual(progress)
    expect(
      MaestroRunProgressV2Schema.safeParse({
        ...progress,
        recently_completed: [{ ...progress.recently_completed[0], successor_reference: undefined }]
      }).success
    ).toBe(false)
  })
})
