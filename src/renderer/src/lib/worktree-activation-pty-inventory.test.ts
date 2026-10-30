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
  it('rejects paired ownership without consulting the client inventory', async () => {
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
    ).rejects.toThrow('Activation PTY inventory is unverifiable')
    expect(listSessions).not.toHaveBeenCalled()
  })
})
