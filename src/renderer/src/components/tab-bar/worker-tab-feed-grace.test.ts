import { afterEach, expect, it, vi } from 'vitest'
import { recordWorkerTabFeed, workerTabGraceEndsAt } from './worker-tab-feed-grace'

afterEach(() => vi.restoreAllMocks())

it('bounds a restored worker with no feeds to twenty seconds after reconnect', () => {
  vi.spyOn(Date, 'now').mockReturnValue(50_000)
  recordWorkerTabFeed('runtime:grace-deadline', 'reconnect')
  expect(workerTabGraceEndsAt('runtime:grace-deadline', 0, 69_999)).toBe(70_000)
  expect(workerTabGraceEndsAt('runtime:grace-deadline', 0, 70_000)).toBeNull()
})

it('ends restored grace after both feeds, including an empty combined remote snapshot', () => {
  vi.spyOn(Date, 'now').mockReturnValue(50_000)
  recordWorkerTabFeed('runtime:grace-feeds', 'reconnect')
  recordWorkerTabFeed('runtime:grace-feeds', 'status')
  expect(workerTabGraceEndsAt('runtime:grace-feeds', 0, 50_001)).toBe(70_000)
  recordWorkerTabFeed('runtime:grace-feeds', 'orchestration')
  expect(workerTabGraceEndsAt('runtime:grace-feeds', 0, 50_001)).toBeNull()
  recordWorkerTabFeed('runtime:grace-snapshot', 'reconnect')
  recordWorkerTabFeed('runtime:grace-snapshot', 'snapshot')
  expect(workerTabGraceEndsAt('runtime:grace-snapshot', 0, 50_001)).toBeNull()
  recordWorkerTabFeed('runtime:grace-snapshot', 'failed')
  recordWorkerTabFeed('runtime:grace-snapshot', 'snapshot')
  expect(workerTabGraceEndsAt('runtime:grace-snapshot', 50_000, 50_001)).toBe(60_000)
})

it('fails open on host failure and starts a fresh bounded grace on reconnect', () => {
  vi.spyOn(Date, 'now').mockReturnValue(50_000)
  recordWorkerTabFeed('ssh:grace-recovery', 'failed')
  expect(workerTabGraceEndsAt('ssh:grace-recovery', 49_999, 50_001)).toBeNull()
  recordWorkerTabFeed('ssh:grace-recovery', 'reconnect')
  expect(workerTabGraceEndsAt('ssh:grace-recovery', 0, 50_001)).toBe(70_000)
})
