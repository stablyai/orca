import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selectTerminalWorktreeParkAuthorityRevisionScopeKey } from './terminal-park-authority-revision'

const TERMINAL_SOURCE = readFileSync(new URL('../Terminal.tsx', import.meta.url), 'utf8')

describe('terminal park authority dependencies', () => {
  it('keys the worktree parking pass on web-mirror authority revisions', () => {
    const parkingPass = TERMINAL_SOURCE.slice(
      TERMINAL_SOURCE.indexOf('// Worktree cold-park policy:'),
      TERMINAL_SOURCE.indexOf('// Why here: downloads outlive')
    )

    expect(parkingPass).toContain('terminalWorktreeParkAuthorityRevisionKey')
  })

  it('scopes mirror revisions to the current resolved local owner', () => {
    const worktreeId = 'repo::/worktree'
    const tabsByWorktree = {
      [worktreeId]: [{ id: 'tab-1', ptyId: 'remote:env-owner@@pty-1' }]
    }
    const state = (
      worktreesByRepo: Record<string, object[]>,
      runtimeEnvironmentCatalogHydrated = true
    ) => ({
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      detectedWorktreesByRepo: {},
      folderWorkspaces: [],
      projectGroups: [],
      removedRuntimeEnvironmentIds: new Set<string>(),
      repos: [{ id: 'repo', connectionId: null }],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      runtimeEnvironmentCatalogHydrated,
      runtimeEnvironments: [],
      settings: { activeRuntimeEnvironmentId: null },
      terminalLayoutsByTabId: {},
      worktreesByRepo
    })
    const scope = (
      worktreesByRepo: Record<string, object[]>,
      runtimeEnvironmentCatalogHydrated = true
    ) =>
      selectTerminalWorktreeParkAuthorityRevisionScopeKey(
        state(worktreesByRepo, runtimeEnvironmentCatalogHydrated) as never,
        [worktreeId],
        tabsByWorktree
      )
    const exact = scope({ repo: [{ id: worktreeId, repoId: 'repo', hostId: 'local' }] })
    expect(exact).toBe(JSON.stringify([[worktreeId, ['env-owner']]]))

    expect(scope({ repo: [{ id: worktreeId, repoId: 'repo' }] }, false)).toBe('[]')
    expect(
      scope({
        repo: [
          { id: worktreeId, repoId: 'repo', hostId: 'local' },
          { id: worktreeId, repoId: 'repo', hostId: 'runtime:env-owner' }
        ]
      })
    ).toBe('[]')
    expect(
      scope({ repo: [{ id: worktreeId, repoId: 'repo', hostId: 'runtime:env-foreign' }] })
    ).toBe('[]')
    expect(scope({ repo: [{ id: worktreeId, repoId: 'repo', hostId: 'local' }] })).toBe(exact)
  })
})
