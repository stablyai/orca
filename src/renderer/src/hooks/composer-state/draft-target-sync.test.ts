// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useDraftTargetSync, type DraftTargetSyncInput } from './draft-target-sync'
import { createTestStore } from '../../store/slices/store-test-helpers'
import { repoWithFetchedOwner } from '../../store/repos/owner-routing'
import {
  getProjectHostSetupOwnerKey,
  projectCompatibilityFromRepos
} from '../../store/projects/project-compatibility-core'
import { resolveWorkspaceCreationTarget } from '../../lib/project-host-workspace-target'

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

  it('stores the published setup ID and restores its private receiver owner rather than the picker token', () => {
    const transport = { kind: 'environment', environmentId: 'paired' } as const
    const repos = (['ssh:a', 'ssh:b'] as const).map((host) =>
      repoWithFetchedOwner({ ...createRepo('same-id'), executionHostId: host }, transport)
    )
    const compatibility = projectCompatibilityFromRepos(repos)
    const selectedWorkspaceTarget = resolveWorkspaceCreationTarget({
      eligibleRepos: repos,
      ...compatibility,
      projectHostSetupId: getProjectHostSetupOwnerKey(compatibility.projectHostSetups[1])
    })
    if (selectedWorkspaceTarget.status !== 'ready') {
      throw new Error('Missing selected private receiver setup')
    }
    const store = createTestStore()
    renderHook(() =>
      useDraftTargetSync(
        createState({
          eligibleRepos: repos,
          repoId: 'same-id',
          selectedWorkspaceTarget,
          setNewWorkspaceDraft: store.getState().setNewWorkspaceDraft
        })
      )
    )
    const draft = structuredClone(store.getState().newWorkspaceDraft)
    expect(draft).toMatchObject({
      projectHostSetupId: 'same-id',
      hostId: 'runtime:paired',
      authoritativeExecutionHostId: 'ssh:b'
    })
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: repos,
        ...compatibility,
        projectHostSetupId: draft?.projectHostSetupId,
        hostId: draft?.hostId,
        authoritativeExecutionHostId: draft?.authoritativeExecutionHostId
      })
    ).toMatchObject({ status: 'ready', target: { projectHostSetupId: 'same-id', repo: repos[1] } })
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: repos,
        ...compatibility,
        projectHostSetupId: draft?.projectHostSetupId,
        hostId: draft?.hostId
      })
    ).toMatchObject({ status: 'unavailable' })
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
