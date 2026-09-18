// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
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
