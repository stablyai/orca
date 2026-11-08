import { describe, expect, it } from 'vitest'

import { getActiveWorkspaceOwnerTarget } from './resolved-worktree-execution-host'

describe('getActiveWorkspaceOwnerTarget', () => {
  it('reuses repo proof across unrelated updates and refreshes it for a replacement catalog', () => {
    for (const count of [20, 200]) {
      let idReads = 0
      const repos = Array.from({ length: count }, (_, index) => ({
        get id() {
          idReads++
          return `repo-${index}`
        },
        executionHostId: 'runtime:env-a' as const,
        connectionId: null
      }))
      const legacy = {
        repos,
        activeWorktreeId: 'repo-0::/repo',
        worktreesByRepo: {
          'repo-0': [{ id: 'repo-0::/repo', repoId: 'repo-0' }]
        }
      }
      const explicit = {
        ...legacy,
        worktreesByRepo: {
          'repo-0': [{ id: 'repo-0::/repo', repoId: 'repo-0', hostId: 'runtime:env-a' as const }]
        }
      }
      for (const state of [explicit, legacy]) {
        expect(getActiveWorkspaceOwnerTarget(state)).toEqual({
          kind: 'environment',
          environmentId: 'env-a'
        })
      }
      idReads = 0
      for (let update = 0; update < 20; update++) {
        for (const state of [explicit, legacy]) {
          expect(getActiveWorkspaceOwnerTarget({ ...state })).toEqual({
            kind: 'environment',
            environmentId: 'env-a'
          })
        }
      }
      expect(idReads).toBe(0)

      const replacement = repos.map((repo) => ({
        ...repo,
        executionHostId: 'runtime:env-b' as const
      }))
      expect(getActiveWorkspaceOwnerTarget({ ...legacy, repos: replacement })).toEqual({
        kind: 'environment',
        environmentId: 'env-b'
      })
      expect(
        getActiveWorkspaceOwnerTarget({
          ...legacy,
          repos: [...replacement, { id: 'repo-0', connectionId: null, executionHostId: 'local' }]
        })
      ).toBeNull()
    }
  })
})
