// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetupOption } from '@/lib/project-host-setup-options'
import { useTargetChangeActions } from './target-change-actions'

const readyOption: ProjectHostSetupOption = {
  kind: 'ready',
  id: 'setup-side',
  projectId: 'github:stablyai/orca',
  hostId: 'local',
  repoId: 'orca-side',
  label: 'Local Mac',
  detail: 'orca',
  path: '/checkouts/side'
}

function renderTargetChangeActions(currentRepoId = '') {
  const spies = {
    setRepoId: vi.fn(),
    setProjectError: vi.fn(),
    setSelectedProjectHostSetupOverrideId: vi.fn(),
    setSelectedProjectIdOverride: vi.fn(),
    setSparseEnabled: vi.fn(),
    setSparseSelectedPresetId: vi.fn(),
    setBaseBranch: vi.fn()
  }
  const retargetGitHubPrStartPointSelection = vi.fn(
    (_selection: unknown, repoId: string) => `retargeted:${repoId}`
  )
  const smartGitHubPrStartPointSelectionRef = { current: 'pr-selection' as unknown }
  const noop = vi.fn()
  const { result } = renderHook(() =>
    useTargetChangeActions({
      baseBranch: undefined,
      branchAutoNameRef: { current: null },
      decisions: { retargetGitHubPrStartPointSelection },
      folderSourceRepos: [],
      hostOptions: [],
      linkedWorkItem: null,
      projectHostSetupOptions: [readyOption],
      repoId: currentRepoId,
      selectedRepoProjectId: 'github:stablyai/orca',
      setBranchNameOverride: noop,
      setBranchNameOverridePreservesNameEdits: noop,
      setCompareBaseRef: noop,
      setForkPushWarning: noop,
      setLinkedGitLabIssue: noop,
      setLinkedGitLabMR: noop,
      setLinkedIssue: noop,
      setLinkedPR: noop,
      setLinkedTaskSourceContext: noop,
      setLinkedWorkItem: noop,
      setPushTarget: noop,
      setReuseEligibleBranch: noop,
      setReuseSelectedBranch: noop,
      setSparseDirectories: noop,
      setStartFromResetHint: noop,
      smartGitHubPrStartPointSelectionRef,
      ...spies
    } as unknown as Parameters<typeof useTargetChangeActions>[0])
  )
  return { actions: result.current, spies, smartGitHubPrStartPointSelectionRef }
}

describe('choosing a run target closes the pending checkout question (STA-6080)', () => {
  it('clears the pending project when a setup is picked', () => {
    const { actions, spies } = renderTargetChangeActions()

    actions.handleProjectHostSetupChange('setup-side')

    expect(spies.setSelectedProjectHostSetupOverrideId).toHaveBeenCalledWith('setup-side')
    expect(spies.setSelectedProjectIdOverride).toHaveBeenCalledWith(null)
    expect(spies.setRepoId).toHaveBeenCalledWith('orca-side')
  })

  it('clears the pending project when a repo is chosen directly', () => {
    const { actions, spies } = renderTargetChangeActions()

    actions.handleRepoChange('orca-main')

    expect(spies.setSelectedProjectIdOverride).toHaveBeenCalledWith(null)
  })
})

/**
 * Two setups of one project can carry the same repo id (the same repo registered on two hosts), so
 * switching run target resolves to the repo the composer is already on and trips `handleRepoChange`'s
 * same-id early return. `forceResetStartFrom: true` at that call is the only thing that still clears
 * the repo-scoped sparse selection and retargets an in-flight PR start point onto the new host.
 */
describe('switching run target to a setup with the same repo id', () => {
  it('still resets repo-scoped state past the same-id early return', () => {
    const { actions, spies, smartGitHubPrStartPointSelectionRef } =
      renderTargetChangeActions('orca-side')

    actions.handleProjectHostSetupChange('setup-side')

    expect(spies.setSparseEnabled).toHaveBeenCalledWith(false)
    expect(spies.setSparseSelectedPresetId).toHaveBeenCalledWith(null)
    expect(spies.setBaseBranch).toHaveBeenCalledWith(undefined)
    expect(smartGitHubPrStartPointSelectionRef.current).toBe('retargeted:orca-side')
  })

  it('keeps the task source, which is what preserveStartFrom protects', () => {
    const { actions, spies } = renderTargetChangeActions('orca-side')

    actions.handleProjectHostSetupChange('setup-side')

    // preserveStartFrom keeps the setup override and the linked source; only repo-scoped state goes.
    expect(spies.setSelectedProjectHostSetupOverrideId).toHaveBeenCalledTimes(1)
    expect(spies.setSelectedProjectHostSetupOverrideId).toHaveBeenCalledWith('setup-side')
  })
})
