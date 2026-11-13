import { afterEach, describe, expect, it, vi } from 'vitest'

const track = vi.fn()
vi.mock('@/diagnostics/telemetry/telemetry', () => ({
  track: (...args: unknown[]) => track(...args)
}))

import { eventSchemas } from '../../../../shared/telemetry-events'
import {
  cloudSetupDurationBucket,
  diffCloudSetupTelemetry,
  recordCloudSetupFirstSandbox,
  reportCloudSetupProgress,
  resetCloudSetupTelemetry,
  type CloudSetupTelemetryStep
} from './cloud-setup-telemetry'

const rows = (
  account: string,
  team: string,
  github: string,
  plan?: string
): CloudSetupTelemetryStep[] => [
  { id: 'account', state: account },
  { id: 'team', state: team },
  ...(plan ? [{ id: 'plan' as const, state: plan }] : []),
  { id: 'github', state: github }
]

describe('diffCloudSetupTelemetry', () => {
  it('reports started and done per row, never rows already done on first sight', () => {
    const first = diffCloudSetupTelemetry(null, rows('done', 'active', 'pending'), null, 0)
    expect(first.events).toEqual([{ name: 'cloud_setup_step_started', props: { step: 'team' } }])

    const second = diffCloudSetupTelemetry(first.next, rows('done', 'done', 'active'), null, 45_000)
    expect(second.events).toEqual([
      { name: 'cloud_setup_step_done', props: { step: 'team', duration_bucket: '30s_2m' } },
      { name: 'cloud_setup_step_started', props: { step: 'github' } }
    ])

    const same = diffCloudSetupTelemetry(second.next, rows('done', 'done', 'active'), null, 50_000)
    expect(same.events).toEqual([])
  })

  it('reports a plan step finishing as a plan chosen, with the trial context', () => {
    const first = diffCloudSetupTelemetry(null, rows('done', 'done', 'done', 'active'), null, 0)
    const second = diffCloudSetupTelemetry(
      first.next,
      rows('done', 'done', 'done', 'done'),
      null,
      400_000,
      { afterTrial: true }
    )
    expect(second.events).toContainEqual({
      name: 'cloud_setup_plan_chosen',
      props: { after_trial: true }
    })
  })

  it('charges an error to the row in the browser, once per kind', () => {
    const first = diffCloudSetupTelemetry(null, rows('done', 'active', 'pending'), 'timed_out', 0)
    expect(first.events).toContainEqual({
      name: 'cloud_setup_step_failed',
      props: { step: 'team', error_kind: 'timed_out' }
    })
    const again = diffCloudSetupTelemetry(
      first.next,
      rows('done', 'active', 'pending'),
      'timed_out',
      1
    )
    expect(again.events).toEqual([])
  })

  it('falls back to the first unfinished row, then account', () => {
    const blamed = diffCloudSetupTelemetry(
      null,
      rows('done', 'needed', 'pending'),
      'wrong_account',
      0
    )
    expect(blamed.events).toContainEqual({
      name: 'cloud_setup_step_failed',
      props: { step: 'team', error_kind: 'wrong_account' }
    })
    const none = diffCloudSetupTelemetry(null, [], 'team_create_failed', 0)
    expect(none.events).toContainEqual({
      name: 'cloud_setup_step_failed',
      props: { step: 'account', error_kind: 'team_create_failed' }
    })
  })

  it('emits only payloads the registry accepts', () => {
    const first = diffCloudSetupTelemetry(
      null,
      rows('done', 'active', 'pending', 'active'),
      null,
      0
    )
    const { events } = diffCloudSetupTelemetry(
      first.next,
      rows('done', 'done', 'active', 'done'),
      'bank_step',
      2_000_000
    )
    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(eventSchemas[event.name].safeParse(event.props).success).toBe(true)
    }
  })
})

describe('cloudSetupDurationBucket', () => {
  it('buckets elapsed time', () => {
    expect(cloudSetupDurationBucket(-5)).toBe('lt_30s')
    expect(cloudSetupDurationBucket(29_999)).toBe('lt_30s')
    expect(cloudSetupDurationBucket(120_000)).toBe('2m_5m')
    expect(cloudSetupDurationBucket(299_999)).toBe('2m_5m')
    expect(cloudSetupDurationBucket(300_000)).toBe('5m_15m')
    expect(cloudSetupDurationBucket(900_000)).toBe('gte_15m')
  })
})

describe('reportCloudSetupProgress / recordCloudSetupFirstSandbox', () => {
  afterEach(() => {
    track.mockClear()
    resetCloudSetupTelemetry()
  })

  it('tracks per session and measures time to first sandbox from first sight', () => {
    reportCloudSetupProgress('cs_a', rows('done', 'active', 'pending'), null, { now: 1_000 })
    reportCloudSetupProgress('cs_a', rows('done', 'done', 'done'), null, { now: 61_000 })
    expect(track).toHaveBeenCalledWith('cloud_setup_step_started', { step: 'team' })
    expect(track).toHaveBeenCalledWith('cloud_setup_step_done', {
      step: 'team',
      duration_bucket: '30s_2m'
    })
    recordCloudSetupFirstSandbox({ sessionId: 'cs_a', hoursSource: 'trial', now: 200_000 })
    expect(track).toHaveBeenLastCalledWith('cloud_setup_first_sandbox', {
      duration_bucket: '2m_5m',
      hours_source: 'trial'
    })
  })

  it('skips time to first sandbox for a session it never saw', () => {
    recordCloudSetupFirstSandbox({ sessionId: 'cs_unknown', hoursSource: 'plan' })
    expect(track).not.toHaveBeenCalled()
  })
})
