import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getCachedWindowsTerminalCapabilities,
  loadWindowsTerminalCapabilities,
  refreshWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests,
  selectWindowsTerminalCapabilitiesForOwner
} from './windows-terminal-capabilities'

function stubTerminalCapabilityApi(args: {
  wslAvailable: boolean
  pwshAvailable: boolean
  wslDistros?: string[]
  gitBashAvailable?: boolean
  hostPlatform?: NodeJS.Platform | null
}): {
  wslIsAvailable: ReturnType<typeof vi.fn>
  wslListDistros: ReturnType<typeof vi.fn>
  pwshIsAvailable: ReturnType<typeof vi.fn>
  isGitBashAvailable: ReturnType<typeof vi.fn>
  runtimeGetStatus: ReturnType<typeof vi.fn>
} {
  const wslIsAvailable = vi.fn().mockResolvedValue(args.wslAvailable)
  const wslListDistros = vi.fn().mockResolvedValue(args.wslDistros ?? [])
  const pwshIsAvailable = vi.fn().mockResolvedValue(args.pwshAvailable)
  const isGitBashAvailable = vi.fn().mockResolvedValue(args.gitBashAvailable ?? false)
  const runtimeGetStatus = vi
    .fn()
    .mockResolvedValue({ hostPlatform: 'hostPlatform' in args ? args.hostPlatform : 'win32' })

  vi.stubGlobal('window', {
    api: {
      wsl: { isAvailable: wslIsAvailable, listDistros: wslListDistros },
      pwsh: { isAvailable: pwshIsAvailable },
      gitBash: { isAvailable: isGitBashAvailable },
      runtime: { getStatus: runtimeGetStatus }
    }
  })

  return { wslIsAvailable, wslListDistros, pwshIsAvailable, isGitBashAvailable, runtimeGetStatus }
}

describe('windows terminal capabilities', () => {
  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    vi.unstubAllGlobals()
  })

  it('shares WSL, PowerShell, and Git Bash availability between terminal UI consumers', async () => {
    const {
      wslIsAvailable,
      wslListDistros,
      pwshIsAvailable,
      isGitBashAvailable,
      runtimeGetStatus
    } = stubTerminalCapabilityApi({
      wslAvailable: true,
      pwshAvailable: true,
      wslDistros: ['Ubuntu'],
      gitBashAvailable: true
    })

    expect(getCachedWindowsTerminalCapabilities()).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })

    const expected = {
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: true,
      hostPlatform: 'win32',
      isLoading: false
    }
    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual(expected)
    expect(getCachedWindowsTerminalCapabilities()).toEqual(expected)

    await loadWindowsTerminalCapabilities()
    expect(wslIsAvailable).toHaveBeenCalledTimes(1)
    expect(wslListDistros).toHaveBeenCalledTimes(1)
    expect(pwshIsAvailable).toHaveBeenCalledTimes(1)
    expect(isGitBashAvailable).toHaveBeenCalledTimes(1)
    expect(runtimeGetStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps WSL available when the PowerShell version probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(true)
    const pwshIsAvailable = vi.fn().mockRejectedValue(new Error('pwsh probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: true,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
  })

  it('can refresh cached capabilities when WSL availability changes', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toMatchObject({
      wslAvailable: false
    })
    await expect(loadWindowsTerminalCapabilities()).resolves.toMatchObject({
      wslAvailable: false
    })
    await expect(refreshWindowsTerminalCapabilities()).resolves.toMatchObject({
      wslAvailable: true
    })

    expect(wslIsAvailable).toHaveBeenCalledTimes(2)
  })

  it('re-probes when the capability cache expires', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: vi.fn().mockResolvedValue(false) },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })

    await expect(loadWindowsTerminalCapabilities({ now: 1_000 })).resolves.toMatchObject({
      wslAvailable: true
    })
    await expect(loadWindowsTerminalCapabilities({ now: 20_000 })).resolves.toMatchObject({
      wslAvailable: true
    })
    await expect(loadWindowsTerminalCapabilities({ now: 32_000 })).resolves.toMatchObject({
      wslAvailable: false
    })

    expect(wslIsAvailable).toHaveBeenCalledTimes(2)
  })

  it('does not reuse capability cache between runtime owners', async () => {
    const isGitBashAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const runtimeGetStatus = vi
      .fn()
      .mockResolvedValueOnce({ hostPlatform: 'win32' })
      .mockResolvedValueOnce({ hostPlatform: 'linux' })
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: isGitBashAvailable },
        runtime: { getStatus: runtimeGetStatus }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-a' })
    ).resolves.toMatchObject({ gitBashAvailable: true, hostPlatform: 'win32' })
    await expect(
      loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-b' })
    ).resolves.toMatchObject({ gitBashAvailable: false, hostPlatform: 'linux' })

    expect(getCachedWindowsTerminalCapabilities('runtime:host-a')).toMatchObject({
      gitBashAvailable: true,
      hostPlatform: 'win32'
    })
    expect(getCachedWindowsTerminalCapabilities('runtime:host-b')).toMatchObject({
      gitBashAvailable: false,
      hostPlatform: 'linux'
    })
    expect(isGitBashAvailable).toHaveBeenCalledTimes(2)
    expect(runtimeGetStatus).toHaveBeenCalledTimes(2)
  })

  it('loads remote runtime host capabilities through runtime RPC', async () => {
    const runtimeEnvironmentCall = vi.fn(async (args: { selector: string; method: string }) => {
      const resultByMethod: Record<string, unknown> = {
        'status.get': {
          hostPlatform: 'win32',
          runtimeProtocolVersion: 3,
          minCompatibleRuntimeClientVersion: 2
        },
        'host.wsl.isAvailable': true,
        'host.wsl.listDistros': ['Ubuntu'],
        'host.pwsh.isAvailable': true,
        'host.gitBash.isAvailable': false
      }
      return {
        id: args.method,
        ok: true,
        result: resultByMethod[args.method]
      }
    })
    vi.stubGlobal('window', {
      api: {
        runtimeEnvironments: {
          call: runtimeEnvironmentCall
        }
      }
    })

    await expect(
      loadWindowsTerminalCapabilities({
        ownerKey: 'runtime:env-win',
        target: { kind: 'environment', environmentId: 'env-win' }
      })
    ).resolves.toEqual({
      wslAvailable: true,
      wslDistros: ['Ubuntu'],
      pwshAvailable: true,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.wsl.isAvailable' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.wsl.listDistros' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.pwsh.isAvailable' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'host.gitBash.isAvailable' })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-win', method: 'status.get' })
    )
  })

  it('prunes expired runtime owner capability caches', async () => {
    stubTerminalCapabilityApi({
      wslAvailable: false,
      pwshAvailable: false,
      hostPlatform: 'linux'
    })

    await loadWindowsTerminalCapabilities({ ownerKey: 'runtime:old-host', now: 1_000 })
    expect(getCachedWindowsTerminalCapabilities('runtime:old-host')).toMatchObject({
      hostPlatform: 'linux'
    })

    await loadWindowsTerminalCapabilities({ ownerKey: 'runtime:new-host', now: 32_000 })

    expect(getCachedWindowsTerminalCapabilities('runtime:old-host')).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
  })

  it('bounds runtime owner capability caches by evicting the oldest owner', async () => {
    stubTerminalCapabilityApi({
      wslAvailable: false,
      pwshAvailable: false,
      hostPlatform: 'linux'
    })

    for (let i = 0; i < 33; i += 1) {
      await loadWindowsTerminalCapabilities({ ownerKey: `runtime:host-${i}`, now: 1_000 + i })
    }

    expect(getCachedWindowsTerminalCapabilities('runtime:host-0')).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
    expect(getCachedWindowsTerminalCapabilities('runtime:host-32')).toMatchObject({
      hostPlatform: 'linux'
    })
  })

  it('does not select the previous owner capabilities while a new owner loads', async () => {
    const isGitBashAvailable = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    vi.stubGlobal('window', {
      api: {
        wsl: {
          isAvailable: vi.fn().mockResolvedValue(false),
          listDistros: vi.fn().mockResolvedValue([])
        },
        pwsh: { isAvailable: vi.fn().mockResolvedValue(false) },
        gitBash: { isAvailable: isGitBashAvailable },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })

    await loadWindowsTerminalCapabilities({ ownerKey: 'runtime:host-a' })
    const previousOwnerState = {
      ownerKey: 'runtime:host-a',
      capabilities: getCachedWindowsTerminalCapabilities('runtime:host-a')
    }

    expect(
      selectWindowsTerminalCapabilitiesForOwner(previousOwnerState, true, 'runtime:host-b')
    ).toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: null,
      isLoading: false
    })
  })

  it('keeps Git Bash unavailable when the Git Bash path probe fails', async () => {
    const wslIsAvailable = vi.fn().mockResolvedValue(false)
    const pwshIsAvailable = vi.fn().mockResolvedValue(false)
    const isGitBashAvailable = vi.fn().mockRejectedValue(new Error('git bash probe failed'))
    vi.stubGlobal('window', {
      api: {
        wsl: { isAvailable: wslIsAvailable, listDistros: vi.fn().mockResolvedValue([]) },
        pwsh: { isAvailable: pwshIsAvailable },
        gitBash: { isAvailable: isGitBashAvailable },
        runtime: { getStatus: vi.fn().mockResolvedValue({ hostPlatform: 'win32' }) }
      }
    })

    await expect(loadWindowsTerminalCapabilities()).resolves.toEqual({
      wslAvailable: false,
      wslDistros: [],
      pwshAvailable: false,
      gitBashAvailable: false,
      hostPlatform: 'win32',
      isLoading: false
    })
  })
})
