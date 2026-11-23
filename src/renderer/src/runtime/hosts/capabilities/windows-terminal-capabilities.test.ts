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
const { holdWindowsTerminalCapabilitiesForReleasedStrip, releaseWindowsTerminalCapabilityHold } =
  await import('./windows-terminal-capability-holds')

describe('capability answers held by released tab strips', () => {
  it('survive expiry while a released strip holds them, and expire once the last hold is dropped', async () => {
    await loadWindowsTerminalCapabilities({ ownerKey: 'host-a', now: 0 })
    holdWindowsTerminalCapabilitiesForReleasedStrip('group-1', 'host-a')
    holdWindowsTerminalCapabilitiesForReleasedStrip('group-2', 'host-a')

    // Another owner's load runs the expiry sweep 60 s later.
    await loadWindowsTerminalCapabilities({ ownerKey: 'host-b', now: 60_000 })
    expect(hasCachedWindowsTerminalCapabilities('host-a')).toBe(true)

    releaseWindowsTerminalCapabilityHold('group-1')
    await loadWindowsTerminalCapabilities({ ownerKey: 'host-b', now: 120_000, force: true })
    expect(hasCachedWindowsTerminalCapabilities('host-a')).toBe(true)

    releaseWindowsTerminalCapabilityHold('group-2')
    await loadWindowsTerminalCapabilities({ ownerKey: 'host-b', now: 180_000, force: true })
    expect(hasCachedWindowsTerminalCapabilities('host-a')).toBe(false)
  })
})
