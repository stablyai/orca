import { describe, expect, it } from 'vitest'
import { canParkTerminalWorktreeRenderers } from './terminal-hidden-view-parking'

type WorktreeOwner = {
  connectionId: string | null | undefined
  runtimeEnvironmentId: string | null
}

function canParkRemotePty(ptyId: string, worktreeOwner: WorktreeOwner): boolean {
  const args = {
    worktreeId: 'repo::/worktree',
    worktreeOwner,
    terminalTabs: [{ id: 'tab-1', ptyId }],
    pendingStartupByTabId: {},
    parkingEnabled: true,
    isVisible: false,
    shouldMeasureHiddenWorktree: false,
    hasActivityTerminalPortal: false,
    hiddenSinceMs: 0,
    nowMs: 1,
    coldParkDelayMs: 0,
    restorePolicy: {
      sshParkingEnabled: true,
      pairedRuntimeParkingEnvironmentIds: new Set(['env-owner', 'env-foreign'])
    }
  } as Parameters<typeof canParkTerminalWorktreeRenderers>[0]
  return canParkTerminalWorktreeRenderers(args)
}

describe('remote PTY parking owner oracle', () => {
  it('rejects a PTY whose paired runtime environment is provably foreign', () => {
    expect(
      canParkRemotePty('remote:env-foreign@@pty-1', {
        connectionId: 'ssh-owner',
        runtimeEnvironmentId: 'env-owner'
      })
    ).toBe(false)
  })

  it('rejects a PTY whose SSH connection is provably foreign', () => {
    expect(
      canParkRemotePty('ssh:ssh-foreign@@pty-1', {
        connectionId: 'ssh-owner',
        runtimeEnvironmentId: 'env-owner'
      })
    ).toBe(false)
  })

  it('admits matching, unknown, ambiguous, and same-connection identities', () => {
    expect(
      canParkRemotePty('remote:env-owner@@generation-b-pty-1', {
        connectionId: 'ssh-owner',
        runtimeEnvironmentId: 'env-owner'
      })
    ).toBe(true)
    expect(
      canParkRemotePty('ssh:ssh-owner@@generation-b-pty-1', {
        connectionId: 'ssh-owner',
        runtimeEnvironmentId: null
      })
    ).toBe(true)
    expect(
      canParkRemotePty('remote:env-foreign@@pty-1', {
        connectionId: undefined,
        runtimeEnvironmentId: null
      })
    ).toBe(true)
    expect(
      canParkRemotePty('ssh:ssh-foreign@@pty-1', {
        connectionId: null,
        runtimeEnvironmentId: null
      })
    ).toBe(true)
  })
})
