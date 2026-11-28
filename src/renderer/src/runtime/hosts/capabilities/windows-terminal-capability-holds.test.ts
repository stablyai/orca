import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'

const { readWindowsTerminalCapabilities } = vi.hoisted(() => ({
  readWindowsTerminalCapabilities: vi.fn(
    async (): Promise<{
      capabilities: {
        wslAvailable: boolean
        wslDistros: string[]
        pwshAvailable: boolean
        gitBashAvailable: boolean
        hostPlatform: NodeJS.Platform | null
        isLoading: boolean
      }
      gitBashProbed: boolean
    }> => ({
      capabilities: {
        wslAvailable: true,
        wslDistros: ['Ubuntu'],
        pwshAvailable: true,
        gitBashAvailable: true,
        hostPlatform: 'win32',
        isLoading: false
      },
      gitBashProbed: true
    })
  )
}))
vi.mock('./windows-terminal-capability-read', () => ({ readWindowsTerminalCapabilities }))

const {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities,
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} = await import('./windows-terminal-capabilities')
const { holdWindowsTerminalCapabilitiesForReleasedStrip } =
  await import('./windows-terminal-capability-holds')

const PROBED_CAPABILITIES = {
  wslAvailable: true,
  wslDistros: ['Ubuntu'],
  pwshAvailable: true,
  gitBashAvailable: true,
  hostPlatform: 'win32' as const,
  isLoading: false
}

describe('a released tab strip returning to its workspace', () => {
  it('still finds its host answer after the cache expires and fills with other hosts', async () => {
    resetWindowsTerminalCapabilitiesForTests()
    readWindowsTerminalCapabilities.mockResolvedValue({
      capabilities: PROBED_CAPABILITIES,
      gitBashProbed: true
    })
    useAppStore.setState({
      groupsByWorktree: {
        'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
      }
    })
    await loadWindowsTerminalCapabilities({ ownerKey: 'host-a', now: 0 })
    holdWindowsTerminalCapabilitiesForReleasedStrip('wt-1', 'group-1', 'host-a')

    for (let host = 0; host < 40; host += 1) {
      await loadWindowsTerminalCapabilities({ ownerKey: `host-${host}`, now: 60_000 })
    }

    expect(hasCachedWindowsTerminalCapabilities('host-a')).toBe(true)
    expect(getCachedWindowsTerminalCapabilities('host-a')).toEqual(PROBED_CAPABILITIES)
  })

  it('keeps one shared placeholder when a read fails before any shell is probed', async () => {
    resetWindowsTerminalCapabilitiesForTests()
    readWindowsTerminalCapabilities.mockImplementation(async () => ({
      capabilities: {
        wslAvailable: false,
        wslDistros: [],
        pwshAvailable: false,
        gitBashAvailable: false,
        hostPlatform: null,
        isLoading: false
      },
      gitBashProbed: false
    }))
    readWindowsTerminalCapabilities.mockClear()

    const first = await loadWindowsTerminalCapabilities({
      ownerKey: 'ssh:down',
      sshConnectionId: 'down',
      now: 0
    })
    const second = await loadWindowsTerminalCapabilities({
      ownerKey: 'ssh:down',
      sshConnectionId: 'down',
      now: 5_000
    })

    expect(readWindowsTerminalCapabilities).toHaveBeenCalledTimes(2)
    expect(first).toBe(second)
    expect(first).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
  })
})
