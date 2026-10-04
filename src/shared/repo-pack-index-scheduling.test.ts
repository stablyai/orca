import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PACK_INDEX_MAINTENANCE_COOLDOWN_MS,
  PACK_INDEX_MAINTENANCE_FAILURE_COOLDOWN_MS
} from './repo-pack-index-maintenance-policy'
import { RepoRefMaintenance } from './repo-ref-maintenance'
import {
  REF_MAINTENANCE_CLEAN_COOLDOWN_MS,
  REF_MAINTENANCE_PACKED_COOLDOWN_MS,
  type RepoRefMaintenanceTarget
} from './repo-ref-maintenance-policy'

const { countLooseRefsMock } = vi.hoisted(() => ({ countLooseRefsMock: vi.fn() }))
vi.mock('./loose-ref-count', () => ({ countLooseRefs: countLooseRefsMock }))

const QUIET_MS = 10
const engines: RepoRefMaintenance[] = []

function fixture(withIndex = true) {
  const resolveRefsDirectory = vi.fn(async () => '/repo/.git/refs')
  const packRefs = vi.fn(async () => {})
  const maintainPackIndex = vi.fn(async () => 'written' as const)
  const target: RepoRefMaintenanceTarget = {
    key: 'local::/repo/.git',
    resolveRefsDirectory,
    packRefs,
    ...(withIndex ? { maintainPackIndex } : {})
  }
  const maintenance = new RepoRefMaintenance({ quietPeriodMs: QUIET_MS, looseRefThreshold: 10 })
  engines.push(maintenance)
  return { maintenance, target, resolveRefsDirectory, packRefs, maintainPackIndex }
}

async function advance(maintenance: RepoRefMaintenance, milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds)
  await maintenance.whenAttemptSettled()
}

beforeEach(() => {
  vi.useFakeTimers()
  countLooseRefsMock.mockResolvedValue({ count: 0, saturated: false })
})

afterEach(() => {
  for (const maintenance of engines.splice(0)) {
    maintenance.dispose()
  }
  vi.useRealTimers()
  vi.resetAllMocks()
})

describe('independent idle pack-index scheduling', () => {
  it('keeps a dirty ref arm until its cooldown ends without needing another fetch', async () => {
    countLooseRefsMock.mockResolvedValue({ count: 20, saturated: true })
    const { maintenance, target, packRefs } = fixture(false)
    maintenance.arm(target)
    await advance(maintenance, QUIET_MS)
    expect(packRefs).toHaveBeenCalledTimes(1)
    maintenance.arm(target)
    await advance(maintenance, REF_MAINTENANCE_PACKED_COOLDOWN_MS - 1)
    expect(packRefs).toHaveBeenCalledTimes(1)
    await advance(maintenance, 1)
    expect(packRefs).toHaveBeenCalledTimes(2)
  })

  it('refreshes changed packs while a low-ref repository is still on ref cooldown', async () => {
    const { maintenance, target, resolveRefsDirectory, maintainPackIndex } = fixture()
    maintenance.arm(target)
    await advance(maintenance, QUIET_MS)
    maintenance.arm(target)
    await advance(maintenance, PACK_INDEX_MAINTENANCE_COOLDOWN_MS - 1)
    expect(maintainPackIndex).toHaveBeenCalledTimes(1)
    await advance(maintenance, 1)
    expect(maintainPackIndex).toHaveBeenCalledTimes(2)
    expect(resolveRefsDirectory).toHaveBeenCalledTimes(1)
    expect(PACK_INDEX_MAINTENANCE_COOLDOWN_MS).toBeLessThan(REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
  })

  it('keeps an index-only arm until its ref cooldown ends without needing another fetch', async () => {
    const { maintenance, target, resolveRefsDirectory, maintainPackIndex } = fixture()
    maintenance.arm(target)
    await advance(maintenance, QUIET_MS)
    await advance(maintenance, PACK_INDEX_MAINTENANCE_COOLDOWN_MS)
    maintenance.arm(target)
    await advance(maintenance, QUIET_MS)
    expect(maintainPackIndex).toHaveBeenCalledTimes(2)
    expect(resolveRefsDirectory).toHaveBeenCalledTimes(1)
    await advance(maintenance, REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
    expect(resolveRefsDirectory).toHaveBeenCalledTimes(2)
  })

  it('retries a failed index sooner without re-probing healthy refs', async () => {
    const { maintenance, target, maintainPackIndex, resolveRefsDirectory } = fixture()
    target.maintainPackIndex = vi.fn(async () => 'failed' as const)
    maintenance.arm(target)
    await advance(maintenance, QUIET_MS)
    maintenance.arm(target)
    await advance(maintenance, PACK_INDEX_MAINTENANCE_FAILURE_COOLDOWN_MS)
    expect(target.maintainPackIndex).toHaveBeenCalledTimes(2)
    expect(resolveRefsDirectory).toHaveBeenCalledTimes(1)
    expect(maintainPackIndex).not.toHaveBeenCalled()
  })

  it('honours idle admission again when a preserved cooldown arm becomes eligible', async () => {
    const { maintenance, target, maintainPackIndex } = fixture()
    let busy = false
    target.isBusy = () => busy
    maintenance.arm(target)
    await advance(maintenance, QUIET_MS)
    maintenance.arm(target)
    busy = true
    await advance(maintenance, PACK_INDEX_MAINTENANCE_COOLDOWN_MS)
    expect(maintainPackIndex).toHaveBeenCalledTimes(1)
    busy = false
    await advance(maintenance, QUIET_MS * 2)
    expect(maintainPackIndex).toHaveBeenCalledTimes(2)
  })

  it('preserves protected user indexes for the longer clean cooldown', async () => {
    const { maintenance, target } = fixture()
    target.maintainPackIndex = vi.fn(async () => 'protected' as const)
    maintenance.arm(target)
    await advance(maintenance, QUIET_MS)
    maintenance.arm(target)
    await advance(maintenance, PACK_INDEX_MAINTENANCE_COOLDOWN_MS)
    expect(target.maintainPackIndex).toHaveBeenCalledTimes(1)
    await advance(maintenance, REF_MAINTENANCE_CLEAN_COOLDOWN_MS)
    expect(target.maintainPackIndex).toHaveBeenCalledTimes(2)
  })

  it('lets a create pause return while an admitted index writer is still running', async () => {
    const { maintenance, target, packRefs } = fixture()
    let started = () => {}
    const writerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let finish = () => {}
    const writer = new Promise<'written'>((resolve) => {
      finish = () => resolve('written')
    })
    target.maintainPackIndex = async () => {
      started()
      return writer
    }
    maintenance.arm(target)
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    await writerStarted
    const release = await maintenance.pause('worktree create')
    expect(packRefs).not.toHaveBeenCalled()
    finish()
    await maintenance.whenAttemptSettled()
    expect(packRefs).not.toHaveBeenCalled()
    release()
  })
})
