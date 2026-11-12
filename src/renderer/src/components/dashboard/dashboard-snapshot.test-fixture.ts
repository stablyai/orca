import { vi } from 'vitest'
import { createTestStore } from '@/store/testing/app-store-test-fixture'
import {
  buildDashboardSnapshot,
  type DashboardSnapshotInput,
  type DashboardSnapshotState
} from './build-dashboard-snapshot'
import { buildDashboardBucketCounts } from './build-dashboard-bucket-counts'

function projectState(state: DashboardSnapshotState, now: number) {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now)
  try {
    const store = createTestStore()
    store.setState(state)
    return store.getState()
  } finally {
    clock.mockRestore()
  }
}

export function buildDashboardSnapshotFixture(
  state: DashboardSnapshotInput,
  now: number,
  ...options: Parameters<typeof buildDashboardSnapshot> extends [unknown, unknown, ...infer Rest]
    ? Rest
    : never
) {
  return buildDashboardSnapshot(
    { ...projectState(state, now), chatNames: state.chatNames },
    now,
    ...options
  )
}

export function buildDashboardBucketCountsFixture(state: DashboardSnapshotState, now: number) {
  return buildDashboardBucketCounts(projectState(state, now), now)
}
