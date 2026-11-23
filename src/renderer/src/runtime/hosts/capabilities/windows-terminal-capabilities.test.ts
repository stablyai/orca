import { describe, expect, it, vi } from 'vitest'

const readWindowsTerminalCapabilities = vi.fn(async () => ({
  wslAvailable: true,
  wslDistros: ['Ubuntu'],
  pwshAvailable: true,
  gitBashAvailable: true,
  hostPlatform: 'win32' as const,
  isLoading: false
}))
vi.mock('./windows-terminal-capability-read', () => ({ readWindowsTerminalCapabilities }))

const { hasCachedWindowsTerminalCapabilities, loadWindowsTerminalCapabilities } =
  await import('./windows-terminal-capabilities')
const { holdWindowsTerminalCapabilitiesForReleasedStrip } =
  await import('./windows-terminal-capability-holds')

describe('a released tab strip returning to its workspace', () => {
  it('still finds its host answer after the cache expires and fills with other hosts', async () => {
    await loadWindowsTerminalCapabilities({ ownerKey: 'host-a', now: 0 })
    holdWindowsTerminalCapabilitiesForReleasedStrip('wt-1', 'group-1', 'host-a', () => true)

    for (let host = 0; host < 40; host += 1) {
      await loadWindowsTerminalCapabilities({ ownerKey: `host-${host}`, now: 60_000 })
    }

    expect(hasCachedWindowsTerminalCapabilities('host-a')).toBe(true)
  })
})
