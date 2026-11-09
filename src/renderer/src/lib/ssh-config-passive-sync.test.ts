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
})
