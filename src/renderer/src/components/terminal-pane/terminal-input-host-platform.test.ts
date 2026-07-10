import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { resolveTerminalInputHostPlatform } from './terminal-input-host-platform'

function state(overrides: Partial<AppState> = {}): AppState {
  return {
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    settings: { activeRuntimeEnvironmentId: null },
    sshConnectionStates: new Map(),
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
