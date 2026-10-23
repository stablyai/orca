// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { getProjectHostSetupSelectionKey } from '@/lib/project-host-setup-options'
import * as decisions from './composer-decisions'
import { useTargetChangeActions } from './target-change-actions'

const original = useAppStore.getState()
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
})
it('selects the returned setup when its host appears only after the setup await', async () => {
  const local = {
    id: 'repo',
    path: '/desktop/repo',
    displayName: 'repo',
    badgeColor: '',
    addedAt: 1,
    upstream: { owner: 'team', repo: 'repo' }
  }
  const projection = projectHostSetupProjectionFromRepos([local])
  useAppStore.setState({
    repos: [local],
    projectHostSetups: [...projection.setups],
    runtimeEnvironments: [],
    runtimeStatusByEnvironmentId: new Map(),
    settings: null,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map()
  })
  const setRepoId = vi.fn()
  const setHost = vi.fn()
  const input: Parameters<typeof useTargetChangeActions>[0] = {
    baseBranch: undefined,
    branchAutoNameRef: { current: '' },
    decisions,
    folderSourceRepos: [],
    hostOptions: [],
    projectHostSetupOptions: [],
    linkedWorkItem: null,
    repoId: 'repo',
    selectedRepoProjectId: projection.projects[0].id,
    smartSourceSelectionRef: { current: null },
    setRepoId,
    setSelectedProjectHostSetupOverrideHostId: setHost,
    setSelectedProjectHostSetupOverrideId: vi.fn(),
    setBaseBranch: vi.fn(),
    setBranchNameOverride: vi.fn(),
    setBranchNameOverridePreservesNameEdits: vi.fn(),
    setCompareBaseRef: vi.fn(),
    setForkPushWarning: vi.fn(),
    setLinkedGitLabIssue: vi.fn(),
    setLinkedGitLabMR: vi.fn(),
    setLinkedIssue: vi.fn(),
    setLinkedPR: vi.fn(),
    setLinkedTaskSourceContext: vi.fn(),
    setLinkedWorkItem: vi.fn(),
    setProjectError: vi.fn(),
    setPushTarget: vi.fn(),
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    setSparseDirectories: vi.fn(),
    setSparseEnabled: vi.fn(),
    setSparseSelectedPresetId: vi.fn(),
    setStartFromResetHint: vi.fn()
  }
  const { result } = renderHook(() => useTargetChangeActions(input))
  const submitted = result.current.handleProjectHostSetupChange
  await Promise.resolve()
  const hostId = 'runtime:wsl%3AUbuntu' as const
  const hosted = { ...local, path: '/home/me/repo', executionHostId: hostId }
  const live = projectHostSetupProjectionFromRepos([local, hosted])
  const setup = live.setups.find((row) => row.hostId === hostId)
  if (!setup) {
    throw new Error('fixture must contain the returned owner setup')
  }
  act(() =>
    useAppStore.setState({
      repos: [local, hosted],
      projectHostSetups: [...live.setups],
      runtimeEnvironments: [
        {
          id: 'wsl:Ubuntu',
          name: 'Ubuntu',
          createdAt: 1,
          updatedAt: 1,
          lastUsedAt: null,
          runtimeId: null,
          endpoints: [],
          preferredEndpointId: 'local'
        }
      ]
    })
  )
  act(() => submitted(getProjectHostSetupSelectionKey(setup)))
  expect(setHost).toHaveBeenCalledWith(hostId)
  expect(setRepoId).toHaveBeenCalledWith(hosted.id)
})
