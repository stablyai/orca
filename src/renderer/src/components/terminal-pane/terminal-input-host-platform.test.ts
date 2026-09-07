import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    settings: { activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    ...overrides
  } as AppState
}

describe('resolveTerminalInputHostPlatform', () => {
  it('uses a paired runtime host platform instead of the macOS client', () => {
    const worktreeId = 'repo::C:\\repo'
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({
          repos: [
            {
              id: 'repo',
              path: 'C:\\repo',
              displayName: 'repo',
              badgeColor: '#000',
              addedAt: 0,
              executionHostId: 'runtime:windows-box'
            }
          ],
          runtimeStatusByEnvironmentId: new Map([
            [
              'windows-box',
              {
                status: { hostPlatform: 'win32' }
              } as AppState['runtimeStatusByEnvironmentId'] extends Map<string, infer T> ? T : never
            ]
          ])
        }),
        worktreeId,
        transport: null
      })
    ).toBe('win32')
  })

  it('uses the active remote runtime PTY owner after worktree ownership changes', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({
          repos: [
            {
              id: 'repo',
              path: 'C:\\repo',
              displayName: 'repo',
              badgeColor: '#000',
              addedAt: 0,
              executionHostId: 'runtime:linux-box'
            }
          ],
          runtimeStatusByEnvironmentId: new Map([
            ['windows-box', { status: { hostPlatform: 'win32' } } as never],
            ['linux-box', { status: { hostPlatform: 'linux' } } as never]
          ])
        }),
        worktreeId: 'repo::C:\\repo',
        transport: {
          getConnectionId: () => null,
          getPtyId: () => 'remote:windows-box@@terminal-1'
        }
      })
    ).toBe('win32')
  })

  it('uses the nested SSH host platform instead of the outer HUB platform', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({
          runtimeStatusByEnvironmentId: new Map([
            ['hub', { status: { hostPlatform: 'linux' } } as never]
          ]),
          sshStateByEnvironment: new Map([
            [
              'hub',
              {
                connectionStates: new Map([['ssh-windows', { remotePlatform: 'win32' } as never]])
              } as never
            ]
          ])
        }),
        worktreeId: 'repo::C:\\repo',
        transport: {
          getConnectionId: () => null,
          getPtyId: () => 'remote:hub@@terminal-1',
          getRuntimeEnvironmentId: () => 'hub',
          getExecutionHostId: () => 'ssh:ssh-windows'
        }
      })
    ).toBe('win32')
  })

  it('uses captured runtime ownership for a legacy remote PTY id', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({
          runtimeStatusByEnvironmentId: new Map([
            ['windows-box', { status: { hostPlatform: 'win32' } } as never]
          ])
        }),
        worktreeId: 'repo::/repo',
        transport: {
          getConnectionId: () => null,
          getPtyId: () => 'remote:terminal-1',
          getRuntimeEnvironmentId: () => 'windows-box'
        }
      })
    ).toBe('win32')
  })

  it('keeps a live local PTY on the client after worktree ownership changes', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({
          repos: [
            {
              id: 'repo',
              path: '/repo',
              displayName: 'repo',
              badgeColor: '#000',
              addedAt: 0,
              executionHostId: 'runtime:windows-box'
            }
          ],
          runtimeStatusByEnvironmentId: new Map([
            ['windows-box', { status: { hostPlatform: 'win32' } } as never]
          ])
        }),
        worktreeId: 'repo::/repo',
        transport: {
          getConnectionId: () => null,
          getPtyId: () => 'local-pty-1',
          getLocalSessionMetadata: () => ({ cwd: '/repo' })
        }
      })
    ).toBe('darwin')
  })

  it('normalizes a live WSL session to a Linux terminal host', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'win32',
        state: state(),
        worktreeId: 'repo::C:\\repo',
        transport: {
          getConnectionId: () => null,
          getPtyId: () => 'local-pty-1',
          getLocalSessionMetadata: () => ({
            shellOverride: '  "C:\\Windows\\System32\\wsl.exe" -d Ubuntu-24.04'
          })
        }
      })
    ).toBe('linux')
  })

  it('keeps a live native Windows session after the worktree switches to WSL', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'win32',
        state: state({
          repos: [
            {
              id: 'repo',
              path: 'C:\\repo',
              displayName: 'repo',
              badgeColor: '#000',
              addedAt: 0,
              executionHostId: 'runtime:linux-box'
            }
          ],
          runtimeStatusByEnvironmentId: new Map([
            ['linux-box', { status: { hostPlatform: 'linux' } } as never]
          ])
        }),
        worktreeId: 'repo::C:\\repo',
        transport: {
          getConnectionId: () => null,
          getPtyId: () => 'windows-pty-1',
          getLocalSessionMetadata: () => ({ cwd: 'C:\\repo', shellOverride: 'pwsh.exe' })
        }
      })
    ).toBe('win32')
  })

  it('uses SSH remote platform metadata', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({
          sshConnectionStates: new Map([['ssh-win', { remotePlatform: 'win32' } as never]])
        }),
        worktreeId: 'repo::C:\\repo',
        transport: { getConnectionId: () => 'ssh-win' }
      })
    ).toBe('win32')
  })

  it('uses conservative POSIX input when SSH platform metadata is unavailable', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({ sshConnectionStates: new Map([['ssh-unknown', {} as never]]) }),
        worktreeId: 'repo::/repo',
        transport: { getConnectionId: () => 'ssh-unknown' }
      })
    ).toBe('linux')
  })

  it('prefers the PTY-owner platform over stale nested SSH state', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({ sshStateByEnvironment: new Map() }),
        worktreeId: 'repo::/repo',
        transport: {
          getConnectionId: () => null,
          getRuntimeEnvironmentId: () => 'hub',
          getExecutionHostId: () => 'ssh:ssh-win',
          getRemotePlatform: () => 'win32'
        }
      })
    ).toBe('win32')
  })

  it('falls back to the client when runtime platform metadata is unavailable', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state(),
        worktreeId: 'repo::/repo',
        transport: {
          getConnectionId: () => null,
          getPtyId: () => 'remote:windows-box@@terminal-1',
          getRuntimeEnvironmentId: () => 'windows-box'
        }
      })
    ).toBe('darwin')
  })

  it('uses the SSH execution host when the transport has no connection id', () => {
    const worktreeId = 'repo::C:\\repo'
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state({
          repos: [
            {
              id: 'repo',
              path: 'C:\\repo',
              displayName: 'repo',
              badgeColor: '#000',
              addedAt: 0,
              executionHostId: 'ssh:ssh-win'
            }
          ],
          sshConnectionStates: new Map([['ssh-win', { remotePlatform: 'win32' } as never]])
        }),
        worktreeId,
        transport: { getConnectionId: () => null }
      })
    ).toBe('win32')
  })

  it('keeps the client platform for local terminals', () => {
    expect(
      resolveTerminalInputHostPlatform({
        clientPlatform: 'darwin',
        state: state(),
        worktreeId: 'repo::/repo',
        transport: null
      })
    ).toBe('darwin')
  })
})
