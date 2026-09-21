// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCachedWindowsTerminalCapabilities,
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from './windows-terminal-capabilities'
import { resetWindowsTerminalCapabilityReprobeForTests } from './windows-terminal-capability-reprobe'

describe('Windows terminal capability probe ordering', () => {
  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    resetWindowsTerminalCapabilityReprobeForTests()
    vi.unstubAllGlobals()
  })

  it('does not let an older forced probe overwrite a newer identity proof', async () => {
    let resolveOlderStatus!: (status: { hostPlatform: NodeJS.Platform }) => void
    let resolveNewerStatus!: (status: {
      hostPlatform: NodeJS.Platform
      windowsProcessStartTimeAvailable: boolean
    }) => void
    const olderStatus = new Promise<{ hostPlatform: NodeJS.Platform }>((resolve) => {
      resolveOlderStatus = resolve
    })
    const newerStatus = new Promise<{
      hostPlatform: NodeJS.Platform
      windowsProcessStartTimeAvailable: boolean
    }>((resolve) => {
      resolveNewerStatus = resolve
    })
    const runtimeGetStatus = vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(olderStatus)
      .mockReturnValueOnce(newerStatus)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: runtimeGetStatus }
      }
    })

    const olderProbe = loadWindowsTerminalCapabilities({
      ownerKey: 'local',
      force: true,
      now: 1_000
    })
    const newerProbe = loadWindowsTerminalCapabilities({
      ownerKey: 'local',
      force: true,
      now: 2_000
    })

    resolveNewerStatus({ hostPlatform: 'win32', windowsProcessStartTimeAvailable: true })
    await expect(newerProbe).resolves.toMatchObject({
      hostPlatform: 'win32',
      windowsProcessStartTimeAvailable: true
    })
    expect(getCachedWindowsTerminalCapabilities('local')).toMatchObject({
      hostPlatform: 'win32',
      windowsProcessStartTimeAvailable: true
    })

    resolveOlderStatus({ hostPlatform: 'win32' })
    await expect(olderProbe).resolves.toMatchObject({
      hostPlatform: 'win32',
      windowsProcessStartTimeAvailable: true
    })
    expect(getCachedWindowsTerminalCapabilities('local')).toMatchObject({
      hostPlatform: 'win32',
      windowsProcessStartTimeAvailable: true
    })
  })
})
