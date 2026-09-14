import { beforeEach, describe, expect, it, vi } from 'vitest'

const listRuntimes = vi.fn()
const cleanup = vi.fn().mockResolvedValue({ status: 'cleaned' })

// @ts-expect-error -- test shim for the preload bridge
globalThis.window = { api: { ephemeralVm: { listRuntimes, cleanup } } }

import { cleanupEphemeralVmRuntimesForDeleted } from './ephemeral-vm-runtime-cleanup'
import { toSshExecutionHostId } from '../../../shared/execution-host'

function runtime(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 'rt', cleanupStatus: 'not_started', ...overrides }
}

describe('cleanupEphemeralVmRuntimesForDeleted', () => {
  beforeEach(() => {
    listRuntimes.mockReset()
    cleanup.mockReset().mockResolvedValue({ status: 'cleaned' })
  })

  it('cleans runtimes matched by workspace id and returns destroyed SSH target ids', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: 'wt-1', sshTargetId: 'runtime-ssh-a' }),
      runtime({ id: 'rt-2', workspaceId: 'wt-other' })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
    expect(destroyed).toEqual({
      destroyedSshTargetIds: ['runtime-ssh-a'],
      retainedSshTargetIds: []
    })
  })

  it('cleans only the confirmed host runtime when another host owns the same workspace id', async () => {
    listRuntimes.mockResolvedValue([
      runtime({
        id: 'rt-a',
        workspaceId: 'wt-1',
        runtimeEnvironmentId: 'env-a'
      }),
      runtime({
        id: 'rt-b',
        workspaceId: 'wt-1',
        runtimeEnvironmentId: 'env-b'
      })
    ])

    await cleanupEphemeralVmRuntimesForDeleted({
      hostScopedWorkspaces: [{ workspaceId: 'wt-1', executionHostId: 'runtime:env-a' }]
    })

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-a' })
  })

  it('cleans only the confirmed SSH-host runtime when target ids need encoding', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-a', workspaceId: 'wt-1', sshTargetId: 'build/a|primary' }),
      runtime({ id: 'rt-b', workspaceId: 'wt-1', sshTargetId: 'build-b' })
    ])

    await cleanupEphemeralVmRuntimesForDeleted({
      hostScopedWorkspaces: [
        { workspaceId: 'wt-1', executionHostId: toSshExecutionHostId('build/a|primary') }
      ]
    })

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-a' })
  })

  it('cleans a runtime matched only by its runtime-owned SSH target id', async () => {
    // The SSH-mode workspace is the repo's main worktree, so project removal must still find the
    // runtime via the repo's connectionId even when no workspace id matches.
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: undefined, sshTargetId: 'runtime-ssh-orca-1' })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({
      runtimeOwnedSshTargetIds: ['runtime-ssh-orca-1']
    })

    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
    expect(destroyed).toEqual({
      destroyedSshTargetIds: ['runtime-ssh-orca-1'],
      retainedSshTargetIds: []
    })
  })

  it('ignores non-runtime-owned target ids and already-cleaned runtimes', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-done', workspaceId: 'wt-1', cleanupStatus: 'succeeded' }),
      runtime({ id: 'rt-user', sshTargetId: 'my-server' })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({
      workspaceIds: ['wt-1'],
      runtimeOwnedSshTargetIds: ['my-server']
    })

    expect(cleanup).not.toHaveBeenCalled()
    expect(destroyed).toEqual({ destroyedSshTargetIds: [], retainedSshTargetIds: [] })
  })

  it('retries a completed provider cleanup while its SSH target remains', async () => {
    listRuntimes.mockResolvedValue([
      runtime({
        id: 'rt-1',
        workspaceId: 'wt-1',
        status: 'cleanup_failed',
        cleanupStatus: 'succeeded',
        sshTargetId: 'runtime-ssh-a'
      })
    ])
    cleanup.mockResolvedValue({ status: 'cleaned', cleanupStatus: 'succeeded' })

    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      { destroyedSshTargetIds: ['runtime-ssh-a'], retainedSshTargetIds: [] }
    )
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
  })

  it('does not report a retained SSH target as destroyed', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: 'wt-1', sshTargetId: 'runtime-ssh-a' })
    ])
    cleanup.mockResolvedValue({
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      sshTargetId: 'runtime-ssh-a'
    })

    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      { destroyedSshTargetIds: [], retainedSshTargetIds: ['runtime-ssh-a'] }
    )
  })

  it('swallows listRuntimes failures', async () => {
    listRuntimes.mockRejectedValue(new Error('boom'))
    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      { destroyedSshTargetIds: [], retainedSshTargetIds: [] }
    )
  })

  it('retains an explicit runtime target when runtime listing fails', async () => {
    listRuntimes.mockRejectedValue(new Error('boom'))

    await expect(
      cleanupEphemeralVmRuntimesForDeleted({
        runtimeOwnedSshTargetIds: ['runtime-ssh-a']
      })
    ).resolves.toEqual({
      destroyedSshTargetIds: [],
      retainedSshTargetIds: ['runtime-ssh-a']
    })
  })
})
