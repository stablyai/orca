import { describe, it, expect } from 'vitest'
import { resolveSshWorkspaceForget } from './ssh-workspace-forget-resolution'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const labels = new Map([['ssh-live', 'Live']])

function route(executionHostId: ExecutionHostId, runtimeEnvironmentId: string | null = null) {
  return { executionHostId, runtimeEnvironmentId }
}

describe('resolveSshWorkspaceForget', () => {
  it('returns not-ssh for a local workspace', () => {
    expect(resolveSshWorkspaceForget({ route: route('local'), sshTargetLabels: labels }).kind).toBe(
      'not-ssh'
    )
  })

  it('returns not-ssh for a runtime-owned target', () => {
    expect(
      resolveSshWorkspaceForget({ route: route('ssh:runtime-ssh-abc'), sshTargetLabels: labels })
        .kind
    ).toBe('not-ssh')
  })

  it('deletes through the Orca server that serves an SSH workspace', () => {
    expect(
      resolveSshWorkspaceForget({ route: route('ssh:ssh-live', 'env-1'), sshTargetLabels: labels })
        .kind
    ).toBe('not-ssh')
  })

  it('returns saved for a configured target this app would route to its own main', () => {
    expect(
      resolveSshWorkspaceForget({ route: route('ssh:ssh-live'), sshTargetLabels: labels })
    ).toEqual({ kind: 'saved', targetId: 'ssh-live' })
  })

  it('returns ghost when the target is no longer configured', () => {
    expect(
      resolveSshWorkspaceForget({ route: route('ssh:ssh-dead'), sshTargetLabels: labels })
    ).toEqual({ kind: 'ghost', targetId: 'ssh-dead' })
  })
})
