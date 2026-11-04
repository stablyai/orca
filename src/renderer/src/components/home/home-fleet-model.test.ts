import { describe, expect, it } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { buildHomeFleet } from './home-fleet-model'

function card(paneKey: string, bucket: DashboardCard['bucket'], stateChangedAt: number) {
  return { paneKey, bucket, stateChangedAt, startedAt: 1, finishedAt: null } as DashboardCard
}

describe('buildHomeFleet', () => {
  it('lists agents waiting on the user oldest first, unknown wait times last', () => {
    const fleet = buildHomeFleet([
      card('newer', 'attention', 300),
      card('unknown', 'attention', 0),
      card('older', 'attention', 100),
      card('busy', 'working', 50),
      card('finished', 'done', 10),
      card('idle', 'idle', 5)
    ])

    expect(fleet.needsYou.map((c) => c.paneKey)).toEqual(['older', 'newer', 'unknown'])
    expect(fleet.runningNow.map((c) => c.paneKey)).toEqual(['busy'])
    expect(fleet.counts).toEqual({ attention: 3, working: 1, done: 1 })
  })
})
