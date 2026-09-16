import { afterEach, describe, expect, it, vi } from 'vitest'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  listActivationPtySessions,
  resolveActivationPtyListScope
} from './worktree-activation-pty-inventory'

const worktreeId = 'repo::/workspace'

afterEach(() => vi.unstubAllGlobals())

function stubListSessions(impl: (scope?: unknown) => Promise<unknown[]>) {
  const listSessions = vi.fn(impl)
  vi.stubGlobal('window', { api: { pty: { listSessions } } })
  return listSessions
}

describe('activation inventory execution scope', () => {
  it('keeps a known local repo usable before unrelated runtime catalogs hydrate', () => {
    expect(
      resolveActivationPtyListScope(
        {
          repos: [{ id: 'repo' }],
          runtimeEnvironments: [],
          runtimeEnvironmentCatalogHydrated: false,
          activeWorktreeId: 'other::/remote',
          activeWorkspaceExecutionHostId: 'ssh:other'
        },
        worktreeId
      )
    ).toEqual({ connectionId: null })
  })

  it('does not use the native repo fallback for an explicitly owned worktree', () => {
    expect(
      resolveActivationPtyListScope(
        {
          repos: [{ id: 'repo' }],
          worktreesByRepo: { repo: [{ id: worktreeId, repoId: 'repo', hostId: 'runtime:hub' }] }
        },
        worktreeId
      )
    ).toBeUndefined()
  })

  it.each(['local', 'ssh:remote%20box'] as const)('resolves only %s', (hostId) => {
    expect(
      resolveActivationPtyListScope(
        {
          repos: [{ id: 'repo', executionHostId: hostId }]
        },
        worktreeId
      )
    ).toEqual({ connectionId: hostId === 'local' ? null : 'remote box' })
  })

  it('resolves folder workspaces without a Git worktree row', () => {
    expect(
      resolveActivationPtyListScope(
        {
          folderWorkspaces: [{ id: 'folder', projectGroupId: 'group', connectionId: 'box' }]
        },
        folderWorkspaceKey('folder')
      )
    ).toEqual({ connectionId: 'box' })
  })

  it('does not choose a provider for missing or ambiguous ownership', () => {
    expect(resolveActivationPtyListScope({}, worktreeId)).toBeUndefined()
    expect(
      resolveActivationPtyListScope(
        {
          repos: [
            { id: 'repo', executionHostId: 'local' },
            { id: 'repo', executionHostId: 'ssh:box' }
          ]
        },
        worktreeId
      )
    ).toBeUndefined()
  })

  it('never routes a paired host or its nested SSH target through client providers', () => {
    for (const hostId of ['runtime:hub', 'ssh:nested'] as const) {
      expect(
        resolveActivationPtyListScope(
          {
            worktreesByRepo: {
              repo: [{ id: worktreeId, repoId: 'repo', hostId, runtimeOwnerEnvironmentId: 'hub' }]
            }
          },
          worktreeId
        )
      ).toBeUndefined()
    }
  })
})

describe('activation inventory census', () => {
  it('asks only the owning provider when the client can name one', async () => {
    const listSessions = stubListSessions(async () => [{ id: 'ssh:box@@pty-1' }])
    await expect(
      listActivationPtySessions({ repos: [{ id: 'repo', executionHostId: 'ssh:box' }] }, worktreeId)
    ).resolves.toEqual([{ id: 'ssh:box@@pty-1' }])
    expect(listSessions).toHaveBeenCalledExactlyOnceWith({ connectionId: 'box' })
  })

  // A paired peer's PTYs never enter this client's registry, so refusing to answer would strand the
  // workspace with no surface at all; the unscoped inventory is the shipped answer for it.
  it('falls back to the unscoped inventory for a workspace it cannot scope', async () => {
    const listSessions = stubListSessions(async () => [])
    await expect(
      listActivationPtySessions(
        {
          worktreesByRepo: {
            repo: [
              {
                id: worktreeId,
                repoId: 'repo',
                hostId: 'runtime:hub',
                runtimeOwnerEnvironmentId: 'hub'
              }
            ]
          }
        },
        worktreeId
      )
    ).resolves.toEqual([])
    expect(listSessions).toHaveBeenCalledExactlyOnceWith()
  })

  it('retries unscoped when the selected relay is detached, and only then', async () => {
    const detached = stubListSessions(async (scope) => {
      if (scope) {
        throw new Error(
          'Error invoking remote method: Error: No PTY provider for connection "box": the SSH relay for this host is not attached'
        )
      }
      return [{ id: 'local-1' }]
    })
    await expect(
      listActivationPtySessions({ repos: [{ id: 'repo', executionHostId: 'ssh:box' }] }, worktreeId)
    ).resolves.toEqual([{ id: 'local-1' }])
    expect(detached.mock.calls).toEqual([[{ connectionId: 'box' }], []])

    const refused = stubListSessions(async () => {
      throw new Error('relay unavailable')
    })
    await expect(
      listActivationPtySessions({ repos: [{ id: 'repo', executionHostId: 'ssh:box' }] }, worktreeId)
    ).rejects.toThrow('relay unavailable')
    expect(refused).toHaveBeenCalledOnce()
  })
})
