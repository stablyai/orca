import { beforeEach, describe, expect, it, vi } from 'vitest'

const listRuntimes = vi.fn()
const cleanup = vi.fn().mockResolvedValue({})

// @ts-expect-error -- test shim for the preload bridge
globalThis.window = { api: { ephemeralVm: { listRuntimes, cleanup } } }

import { cleanupEphemeralVmRuntimesForDeleted } from './ephemeral-vm-runtime-cleanup'

function runtime(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 'rt', cleanupStatus: 'not_started', ...overrides }
}

describe('cleanupEphemeralVmRuntimesForDeleted', () => {
  beforeEach(() => {
    listRuntimes.mockReset()
    cleanup.mockClear()
  })

  it('cleans runtimes matched by workspace id and returns destroyed SSH target ids', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: 'wt-1', sshTargetId: 'runtime-ssh-a' }),
      runtime({ id: 'rt-2', workspaceId: 'wt-other' })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
    expect(destroyed).toEqual(['runtime-ssh-a'])
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
    expect(destroyed).toEqual(['runtime-ssh-orca-1'])
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
    expect(destroyed).toEqual([])
  })

  it('swallows listRuntimes failures', async () => {
    listRuntimes.mockRejectedValue(new Error('boom'))
    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      []
    )
  })
})
