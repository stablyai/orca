import { afterEach, describe, expect, it } from 'vitest'
import { ChecksDetailPollingPolicy } from './checks-detail-polling-policy'
import { setPRAutoRefreshCadence } from '../../review-refresh-policy'

describe('checks detail polling under a PR auto-refresh cadence', () => {
  afterEach(() => setPRAutoRefreshCadence('default'))

  it('keeps today’s failure retry by default', () => {
    const policy = new ChecksDetailPollingPolicy()
    policy.fail()
    expect(policy.delayMs('open', 'pending', 120_000)).toBe(120_000)
    expect(policy.delayMs('open', 'pending', 30_000)).toBe(60_000)
  })

  it('does not retry a failed read on a timer when off, in either host form', () => {
    const policy = new ChecksDetailPollingPolicy()
    policy.fail()
    setPRAutoRefreshCadence('off')
    expect(policy.delayMs('open', 'pending', 120_000)).toBeNull()
    setPRAutoRefreshCadence('default')
    expect(policy.delayMs('open', 'pending', 120_000, 'off')).toBeNull()
  })

  it('stretches the failure retry like every other timed read', () => {
    const policy = new ChecksDetailPollingPolicy()
    policy.fail()
    expect(policy.delayMs('open', 'pending', 60_000, 'reduced')).toBe(5 * 60_000)
    expect(policy.delayMs('open', 'pending', 60_000, 'minimal')).toBe(10 * 60_000)
  })

  it('follows the passed host cadence over the process cadence', () => {
    const policy = new ChecksDetailPollingPolicy()
    setPRAutoRefreshCadence('off')
    // A paired host on Default keeps polling even though this app is off.
    expect(policy.delayMs('open', 'pending', 60_000, 'default')).toBe(60_000)
  })
})
