import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getProbedLocalGitBashAvailability,
  loadWindowsTerminalCapabilities,
  resetWindowsTerminalCapabilitiesForTests
} from './windows-terminal-capabilities'
import { signInShell } from './windows-terminal-sign-in-shell'
import { resolveExecutionHostAgentStartupShell } from '../platform/execution-host-facts'
import type { ExecutionHostPlatformFact } from '../platform/execution-host-platform-fact'

const LOCAL_WIN32_FACT: ExecutionHostPlatformFact = {
  kind: 'known',
  platform: 'win32',
  hostKind: 'local'
}

const REMOTE_WIN32_FACT: ExecutionHostPlatformFact = {
  kind: 'known',
  platform: 'win32',
  hostKind: 'runtime',
  terminalWindowsShell: 'git-bash'
}

function stubLocalWindowsApi(gitBashIsAvailable: () => Promise<boolean>): void {
  vi.stubGlobal('window', {
    location: { pathname: '/index.html' },
    api: {
      wsl: { isAvailable: () => Promise.resolve(false), listDistros: () => Promise.resolve([]) },
      pwsh: { isAvailable: () => Promise.resolve(false) },
      gitBash: { isAvailable: gitBashIsAvailable },
      runtime: { getStatus: () => Promise.resolve({ hostPlatform: 'win32' }) },
      preflight: {
        detectRemoteWindowsTerminalCapabilities: () =>
          Promise.resolve({
            wslAvailable: false,
            wslDistros: [],
            pwshAvailable: false,
            gitBashAvailable: true,
            hostPlatform: 'win32'
          })
      }
    }
  })
}

describe('local Git Bash probe for startup shell quoting', () => {
  beforeEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
  })

  afterEach(() => {
    resetWindowsTerminalCapabilitiesForTests()
    vi.unstubAllGlobals()
  })

  it('keeps posix quoting before local capabilities have been probed', () => {
    expect(getProbedLocalGitBashAvailability()).toBeUndefined()
    expect(resolveExecutionHostAgentStartupShell(LOCAL_WIN32_FACT, 'git-bash')).toBe('posix')
  })

  it('quotes local launches for PowerShell once Git Bash probes unavailable, even when a remote host was probed', async () => {
    stubLocalWindowsApi(() => Promise.resolve(false))

    await loadWindowsTerminalCapabilities()
    await loadWindowsTerminalCapabilities({ ownerKey: 'ssh:builder', sshConnectionId: 'builder' })

    expect(getProbedLocalGitBashAvailability()).toBe(false)
    expect(resolveExecutionHostAgentStartupShell(LOCAL_WIN32_FACT, 'git-bash')).toBe('powershell')
    expect(resolveExecutionHostAgentStartupShell(REMOTE_WIN32_FACT, 'git-bash')).toBe('posix')
  })

  it('uses PowerShell for a local sign-in command once Git Bash probes unavailable', async () => {
    stubLocalWindowsApi(() => Promise.resolve(false))

    await loadWindowsTerminalCapabilities()

    expect(
      signInShell({
        platform: 'win32',
        isRemote: false,
        hostTerminalWindowsShell: 'git-bash'
      })
    ).toBe('powershell')
  })

  it('keeps posix quoting when the Git Bash probe rejects instead of proving absence', async () => {
    stubLocalWindowsApi(() => Promise.reject(new Error('ipc timeout')))

    await loadWindowsTerminalCapabilities()

    expect(getProbedLocalGitBashAvailability()).toBeUndefined()
    expect(resolveExecutionHostAgentStartupShell(LOCAL_WIN32_FACT, 'git-bash')).toBe('posix')
  })

  it('keeps posix quoting when loading local capabilities fails as a whole', async () => {
    vi.stubGlobal('window', { location: { pathname: '/index.html' } })

    await loadWindowsTerminalCapabilities()

    expect(getProbedLocalGitBashAvailability()).toBeUndefined()
    expect(resolveExecutionHostAgentStartupShell(LOCAL_WIN32_FACT, 'git-bash')).toBe('posix')
  })

  it('ignores local cache in the web client', async () => {
    stubLocalWindowsApi(() => Promise.resolve(false))
    await loadWindowsTerminalCapabilities()

    vi.stubGlobal('window', {
      __ORCA_WEB_CLIENT__: true,
      location: { pathname: '/web-index.html' }
    })

    expect(getProbedLocalGitBashAvailability()).toBeUndefined()
    expect(resolveExecutionHostAgentStartupShell(LOCAL_WIN32_FACT, 'git-bash')).toBe('posix')
  })
})
