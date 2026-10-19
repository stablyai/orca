import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import {
  resetSshConfigPassiveSyncForTests,
  syncSshConfigTargetsPassively
} from './ssh-config-passive-sync'

const importConfig = vi.fn()
const listTargets = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  resetSshConfigPassiveSyncForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  importConfig.mockReset().mockResolvedValue({ targets: [], repoReadoptions: [] })
  listTargets.mockReset().mockResolvedValue([])
  vi.stubGlobal('window', { api: { ssh: { importConfig, listTargets } } })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('syncSshConfigTargetsPassively', () => {
  it('imports without re-adopting deleted hosts and publishes newly added ones', async () => {
    importConfig.mockResolvedValue({
      targets: [{ id: 'ssh-new', label: 'new-box' }],
      repoReadoptions: []
    })
    listTargets.mockResolvedValue([
      { id: 'ssh-old', label: 'old-box' },
      { id: 'ssh-new', label: 'new-box' }
    ])

    await syncSshConfigTargetsPassively()

    expect(importConfig).toHaveBeenCalledWith()
    expect(useAppStore.getState().sshTargetLabels.get('ssh-new')).toBe('new-box')
  })

  it('skips the listing when the config added or changed nothing', async () => {
    await syncSshConfigTargetsPassively()

    expect(importConfig).toHaveBeenCalledTimes(1)
    expect(listTargets).not.toHaveBeenCalled()
  })

  it('shares one sync between callers and waits out the interval before the next', async () => {
    await Promise.all([syncSshConfigTargetsPassively(), syncSshConfigTargetsPassively()])
    await syncSshConfigTargetsPassively()
    expect(importConfig).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(10_000)
    await syncSshConfigTargetsPassively()
    expect(importConfig).toHaveBeenCalledTimes(2)
  })

  it('retries the listing when the import already saved hosts but listing them failed', async () => {
    importConfig.mockResolvedValueOnce({
      targets: [{ id: 'ssh-new', label: 'new-box' }],
      repoReadoptions: []
    })
    listTargets.mockRejectedValueOnce(new Error('ipc busy'))
    await syncSshConfigTargetsPassively()

    listTargets.mockResolvedValue([{ id: 'ssh-new', label: 'new-box' }])
    vi.advanceTimersByTime(10_000)
    await syncSshConfigTargetsPassively()

    expect(useAppStore.getState().sshTargetLabels.get('ssh-new')).toBe('new-box')
  })

  it('swallows a failed import so callers still list known hosts', async () => {
    importConfig.mockRejectedValue(new Error('bad config'))

    await expect(syncSshConfigTargetsPassively()).resolves.toBeUndefined()
  })
})
