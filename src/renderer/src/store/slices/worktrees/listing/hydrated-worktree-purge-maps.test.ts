import { describe, expect, it } from 'vitest'
import type { AppState } from '../../../types'
import {
  folderWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../../../shared/workspace/identity/workspace-scope'
import { purgeHydratedWorktrees } from './hydrated-worktree-purge'
import type { WorktreeRefreshResult } from './worktree-refresh-result'

describe('purgeHydratedWorktrees', () => {
  it('purges dead worktree and folder keys from every session map but keeps live and uncovered remote keys', () => {
    const live = 'repoA::/a/live'
    const staleActiveOnly = 'repoA::/a/stale-active-only'
    const staleAlias = 'repoA::/a/stale-alias'
    const uncoveredSsh = 'repo-hidden::/srv/app'
    const liveFolder = folderWorkspaceKey('live-folder')
    const deletedFolder = folderWorkspaceKey('deleted-folder')
    const purged: unknown[] = []
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hydration purge reads only the fields set here.
    const state = {
      hasHydratedWorktreePurge: false,
      workspaceSessionReady: true,
      hydrationSucceeded: true,
      repos: [{ id: 'repoA', path: '/repos/a' }],
      restoredRuntimeHostIdByWorkspaceSessionKey: {},
      folderWorkspaces: [{ id: 'live-folder' }],
      wslMovedProjects: [],
      detectedWorktreesByRepo: { repoA: { authoritative: true, worktrees: [{ id: live }] } },
      tabsByWorktree: { [live]: [], [deletedFolder]: [] },
      unifiedTabsByWorktree: { [liveFolder]: [] },
      activeTabTypeByWorktree: { [live]: 'terminal', [staleActiveOnly]: 'editor' },
      contestedPrimaryHostBySessionKey: {
        [worktreeWorkspaceKey(staleAlias)]: 'local',
        [uncoveredSsh]: 'ssh:hidden-target'
      },
      purgeWorktreeTerminalState: (targets: unknown[]) => purged.push(...targets)
    } as unknown as AppState
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the purge reads only repoId, hostId and the listing result.
    const results = [
      {
        repoId: 'repoA',
        hostId: 'local',
        refresh: { result: { authoritative: true, worktrees: [{ id: live }] } }
      }
    ] as unknown as WorktreeRefreshResult[]

    purgeHydratedWorktrees(
      (patch) => Object.assign(state, patch),
      () => state,
      results
    )

    expect(state.hasHydratedWorktreePurge).toBe(true)
    expect(new Set(purged)).toEqual(
      new Set([deletedFolder, staleActiveOnly, staleAlias, worktreeWorkspaceKey(staleAlias)])
    )
  })
})
