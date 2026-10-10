// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useBranchStartPointActions } from './branch-start-point-actions'

type Input = Parameters<typeof useBranchStartPointActions>[0]

function createInput(overrides: Partial<Input> = {}): Input {
  return {
    applyLinkedGitLabWorkItem: vi.fn(),
    applyLinkedWorkItem: vi.fn(),
    baseBranch: undefined,
    baseBranchNamesWorkspace: true,
    branchAutoNameRef: { current: 'alice/sta-42-fix-export' },
    handleRepoChange: vi.fn(),
    initialProjectGroupAppliedRef: { current: false },
    lastAutoNoteRef: { current: '' },
    noteRef: { current: '' },
    setBaseBranch: vi.fn(),
    setBaseBranchNamesWorkspace: vi.fn(),
    setBranchNameOverride: vi.fn(),
    setBranchNameOverridePreservesNameEdits: vi.fn(),
    setCompareBaseRef: vi.fn(),
    setForkPushWarning: vi.fn(),
    setNote: vi.fn(),
    setProjectError: vi.fn(),
    setSelectedProjectGroupId: vi.fn(),
    setPushTarget: vi.fn(),
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    setSparseDirectories: vi.fn(),
    setSparseEnabled: vi.fn(),
    setSparseSelectedPresetId: vi.fn(),
    setStartFromResetHint: vi.fn(),
    smartGitHubPrStartPointSelectionRef: { current: null },
    ...overrides
  }
}

describe('composer base changes', () => {
  it('marks a PR head as source-owned after replacing an independent base', () => {
    const input = createInput({ baseBranch: 'release/1.2', baseBranchNamesWorkspace: false })
    const { result } = renderHook(() => useBranchStartPointActions(input))

    act(() =>
      result.current.handleBaseBranchPrSelect('refs/pull/42/head', {
        id: 'pr-42',
        type: 'pr',
        number: 42,
        title: 'Fix export',
        state: 'open',
        url: 'https://github.com/o/r/pull/42',
        labels: [],
        updatedAt: '',
        author: null,
        repoId: 'repo-1'
      })
    )

    expect(input.setBaseBranch).toHaveBeenCalledWith('refs/pull/42/head')
    expect(input.setBaseBranchNamesWorkspace).toHaveBeenCalledWith(true)
  })

  it.each([
    { baseBranch: undefined, baseBranchNamesWorkspace: true },
    { baseBranch: 'release/1.2', baseBranchNamesWorkspace: false }
  ])('preserves independent branch naming state from %j', (previous) => {
    const input = createInput(previous)
    const { result } = renderHook(() => useBranchStartPointActions(input))

    act(() => result.current.handleBaseBranchChange('release/2.0'))
    act(() => result.current.handleBaseBranchChange(undefined))

    expect(input.setBaseBranch).toHaveBeenNthCalledWith(1, 'release/2.0')
    expect(input.setBaseBranch).toHaveBeenNthCalledWith(2, undefined)
    expect(input.setBaseBranchNamesWorkspace).toHaveBeenCalledWith(false)
    expect(input.setBranchNameOverride).not.toHaveBeenCalled()
    expect(input.setBranchNameOverridePreservesNameEdits).not.toHaveBeenCalled()
    expect(input.branchAutoNameRef.current).toBe('alice/sta-42-fix-export')
  })

  it('still drops branch reuse and its pinned name when replacing a source-owned base', () => {
    const input = createInput({ baseBranch: 'feature/existing' })
    const { result } = renderHook(() => useBranchStartPointActions(input))

    act(() => result.current.handleBaseBranchChange('release/2.0'))

    expect(input.setBranchNameOverride).toHaveBeenCalledWith(undefined)
    expect(input.setBranchNameOverridePreservesNameEdits).toHaveBeenCalledWith(false)
    expect(input.setReuseEligibleBranch).toHaveBeenCalledWith(null)
    expect(input.setReuseSelectedBranch).toHaveBeenCalledWith(false)
    expect(input.branchAutoNameRef.current).toBe('')
  })
})
