import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import { repo, worktree } from './worktree-list-groups-test-fixtures'
import { computeVisibleWorktrees, type VisibleWorktreeOptions } from './visible-worktrees'

const secretRepo: Repo = { ...repo, id: 'repo-secret', displayName: 'secret', incognito: true }
const shown: Worktree = { ...worktree, id: 'shown' }
const secret: Worktree = { ...worktree, id: 'secret', repoId: secretRepo.id }
const secretChild: Worktree = { ...worktree, id: 'secret-child', repoId: secretRepo.id }

const baseOptions: VisibleWorktreeOptions = {
  filterRepoIds: [],
  showSleepingWorkspaces: true,
  tabsByWorktree: {},
  ptyIdsByTabId: {},
  worktreeIdsWithLiveAgent: new Set(),
  hideDefaultBranchWorkspace: false,
  hideAutomationGeneratedWorkspaces: false,
  hideCliCreatedWorkspaces: false,
  hideDetachedHeadWorkspaces: false,
  hideWorkspacesFromOtherDevices: false,
  pairedDeviceIdsByEnvironment: new Map(),
  repoMap: new Map([
    [repo.id, repo],
    [secretRepo.id, secretRepo]
  ]),
  workspaceHostScope: 'all',
  defaultHostId: 'local',
  worktreeLineageById: {}
}

const worktreesByRepo = { [repo.id]: [shown], [secretRepo.id]: [secret, secretChild] }
const sortedIds = ['shown', 'secret', 'secret-child']

function visibleIds(overrides: Partial<VisibleWorktreeOptions> = {}): string[] {
  return computeVisibleWorktrees(worktreesByRepo, sortedIds, { ...baseOptions, ...overrides }).map(
    (row) => row.id
  )
}

describe('computeVisibleWorktrees incognito concealment', () => {
  it('shows incognito workspaces when nothing is concealed', () => {
    expect(visibleIds()).toEqual(['shown', 'secret', 'secret-child'])
  })

  it('drops every workspace of a concealed repo', () => {
    expect(visibleIds({ concealedRepoIds: new Set([secretRepo.id]) })).toEqual(['shown'])
  })

  it('keeps a forced-visible workspace hidden while its repo is concealed', () => {
    expect(
      visibleIds({
        concealedRepoIds: new Set([secretRepo.id]),
        forcedVisibleWorktreeIds: ['secret']
      })
    ).toEqual(['shown'])
  })

  it('does not reinject a concealed lineage parent above a visible child', () => {
    const lineage: WorktreeLineage = {
      worktreeId: shown.id,
      worktreeInstanceId: 'shown-instance',
      parentWorktreeId: secret.id,
      parentWorktreeInstanceId: 'secret-instance',
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
    expect(
      visibleIds({
        concealedRepoIds: new Set([secretRepo.id]),
        worktreeLineageById: { [shown.id]: lineage }
      })
    ).toEqual(['shown'])
  })
})
