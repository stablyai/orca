// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { useDraftTargetSync, type DraftTargetSyncInput } from './draft-target-sync'

function createRepo(id: string): DraftTargetSyncInput['eligibleRepos'][number] {
  return {
    id,
    path: `/repos/${id}`,
    displayName: id,
    badgeColor: '#000000',
    addedAt: 0
  }
}

function createState(overrides: Partial<DraftTargetSyncInput> = {}): DraftTargetSyncInput {
  const defaults = {
    agentPrompt: 'Fix the issue',
    attachmentPaths: ['/tmp/context.txt'],
    baseBranch: 'main',
    baseBranchNamesWorkspace: true,
    compareBaseRef: 'origin/main',
    eligibleRepos: [],
    fetchSparsePresets: vi.fn<DraftTargetSyncInput['fetchSparsePresets']>(),
    folderSourceRepos: [],
    isProjectGroupTarget: false,
    linkedGitLabIssue: null,
    linkedGitLabMR: null,
    linkedIssue: '',
    linkedPR: null,
    linkedWorkItem: null,
    name: 'workspace-name',
    note: 'note',
    persistDraft: true,
    pendingInitialWorkspaceTarget: null,
    repoId: '',
    selectedProjectGroup: null,
    selectedRepo: undefined,
    selectedRepoIsGit: false,
    selectedWorkspaceTarget: {
      status: 'unavailable',
      reason: 'no-eligible-repo'
    },
    setNewWorkspaceDraft: vi.fn<DraftTargetSyncInput['setNewWorkspaceDraft']>(),
    setRepoId: vi.fn<DraftTargetSyncInput['setRepoId']>(),
    sparsePresetsByRepo: {},
    taskSourceContext: null,
    tuiAgent: 'claude'
  } satisfies DraftTargetSyncInput
  return { ...defaults, ...overrides }
}

describe('useDraftTargetSync', () => {
  it('persists an unresolved checkout choice and its host without repairing it to the first repo', () => {
    const remoteIdentity = {
      canonicalKey: 'github.com/acme/app',
      remoteName: 'origin',
      remoteUrl: 'https://github.com/acme/app.git'
    }
    const repos = ['checkout-a', 'checkout-b'].map((id) => ({
      ...createRepo(id),
      gitRemoteIdentity: remoteIdentity
    }))
    const projection = projectHostSetupProjectionFromRepos(repos)
    const selectedWorkspaceTarget = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      projects: projection.projects,
      projectHostSetups: projection.setups,
      projectId: projection.projects[0].id,
      hostId: 'local'
    })
    const state = createState({ eligibleRepos: repos, selectedWorkspaceTarget })

    renderHook(() => useDraftTargetSync(state))

    expect(selectedWorkspaceTarget.status).toBe('ambiguous')
    expect(state.setNewWorkspaceDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: null,
        projectId: projection.projects[0].id,
        hostId: 'local',
        projectHostSetupId: null
      })
    )
    expect(state.setRepoId).not.toHaveBeenCalled()
  })

  it('persists the current external draft before repairing an empty repo target', () => {
    const calls: string[] = []
    const setNewWorkspaceDraft = vi.fn(() => calls.push('persist'))
    const setRepoId = vi.fn(() => calls.push('repair'))
    const state = createState({
      eligibleRepos: [createRepo('repo-1')],
      setNewWorkspaceDraft,
      setRepoId
    })

    renderHook(() => useDraftTargetSync(state))

    expect(calls).toEqual(['persist', 'repair'])
    expect(setNewWorkspaceDraft).toHaveBeenCalledTimes(1)
    expect(setRepoId).toHaveBeenCalledTimes(1)
    expect(setNewWorkspaceDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: null,
        name: 'workspace-name',
        prompt: 'Fix the issue',
        attachments: ['/tmp/context.txt'],
        baseBranch: 'main',
        compareBaseRef: 'origin/main'
      })
    )
    expect(setRepoId).toHaveBeenCalledWith('repo-1')
  })

  it('persists whether the base ref also names the workspace', () => {
    const setNewWorkspaceDraft = vi.fn<DraftTargetSyncInput['setNewWorkspaceDraft']>()
    const state = createState({
      eligibleRepos: [createRepo('repo-1')],
      baseBranch: 'release/2.1',
      baseBranchNamesWorkspace: false,
      setNewWorkspaceDraft
    })

    renderHook(() => useDraftTargetSync(state))

    expect(setNewWorkspaceDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        baseBranch: 'release/2.1',
        baseBranchNamesWorkspace: false
      })
    )
  })

  it('does not persist or repair transient quick-composer state', () => {
    const state = createState({
      persistDraft: false,
      isProjectGroupTarget: true,
      eligibleRepos: [createRepo('repo-1')]
    })

    renderHook(() => useDraftTargetSync(state))

    expect(state.setNewWorkspaceDraft).not.toHaveBeenCalled()
    expect(state.setRepoId).not.toHaveBeenCalled()
  })

  it('loads sparse presets only once for a local git repo', () => {
    const fetchSparsePresets = vi.fn()
    const state = createState({
      repoId: 'repo-1',
      selectedRepoIsGit: true,
      selectedRepo: createRepo('repo-1'),
      fetchSparsePresets,
      sparsePresetsByRepo: {}
    })
    const hook = renderHook(() => useDraftTargetSync(state))

    expect(fetchSparsePresets).toHaveBeenCalledWith('repo-1')

    hook.rerender()
    expect(fetchSparsePresets).toHaveBeenCalledTimes(1)
  })
})
