// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useIssueSourceActions } from './issue-source-actions'
import { resolveDraftBaseBranchNamesWorkspace } from './workspace-identity-state'
import { useGitHubProviderSelection } from './github-provider-selection'

type Input = Parameters<typeof useIssueSourceActions>[0]

function createInput(overrides: Partial<Input> = {}): Input {
  return {
    baseBranch: undefined,
    baseBranchNamesWorkspace: true,
    branchAutoNameRef: { current: '' },
    isProjectGroupTarget: false,
    lastAutoNameRef: { current: '' },
    lastAutoNoteRef: { current: '' },
    linkedWorkItem: null,
    name: '',
    noteRef: { current: '' },
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
    setName: vi.fn(),
    setNote: vi.fn(),
    setPushTarget: vi.fn(),
    setReuseEligibleBranch: vi.fn(),
    setReuseSelectedBranch: vi.fn(),
    setStartFromResetHint: vi.fn(),
    smartGitHubPrStartPointSelectionRef: { current: null },
    ...overrides
  } as Input
}

describe('composer name source selection', () => {
  it.each([false, true])('clears only source-owned bases when selecting Jira (%s)', (owned) => {
    const input = createInput({ baseBranch: 'release/1.2', baseBranchNamesWorkspace: owned })
    const { result } = renderHook(() => useIssueSourceActions(input))

    act(() =>
      result.current.handleSmartJiraIssueSelect(
        {
          id: '42',
          key: 'APP-42',
          title: 'Fix export',
          url: 'https://jira.example/browse/APP-42',
          project: { id: 'app', key: 'APP', name: 'App' },
          issueType: { id: 'bug', name: 'Bug' },
          status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To do' },
          labels: [],
          updatedAt: '',
          createdAt: ''
        },
        { kind: 'task-source', provider: 'jira', projectId: 'app', hostId: 'local' }
      )
    )

    expect(input.setBaseBranch).toHaveBeenCalledTimes(owned ? 1 : 0)
    if (owned) {
      expect(input.setBaseBranch).toHaveBeenCalledWith(undefined)
    }
  })

  it.each([false, true])('clears only source-owned bases when removing a source (%s)', (owned) => {
    const input = createInput({ baseBranch: 'release/1.2', baseBranchNamesWorkspace: owned })
    const { result } = renderHook(() => useIssueSourceActions(input))

    act(() => result.current.handleClearSmartNameSelection())

    expect(input.setBaseBranch).toHaveBeenCalledTimes(owned ? 1 : 0)
    if (owned) {
      expect(input.setBaseBranch).toHaveBeenCalledWith(undefined)
    }
  })

  it.each([false, true])(
    'clears only source-owned bases when selecting a GitHub issue (%s)',
    (owned) => {
      const input = {
        ...createInput({ baseBranch: 'release/1.2', baseBranchNamesWorkspace: owned }),
        applyLinkedWorkItem: vi.fn(),
        eligibleRepos: [],
        handleBaseBranchPrSelect: vi.fn(),
        selectedRepo: undefined,
        selectedRepoGitHubSourceContext: null,
        settings: null
      }
      const { result } = renderHook(() => useGitHubProviderSelection(input))

      act(() =>
        result.current.handleSmartGitHubItemSelect({
          id: 'issue-42',
          type: 'issue',
          number: 42,
          title: 'Fix export',
          state: 'open',
          url: 'https://github.com/o/r/issues/42',
          labels: [],
          updatedAt: '',
          author: null,
          repoId: 'repo-1'
        })
      )

      expect(input.setBaseBranch).toHaveBeenCalledTimes(owned ? 1 : 0)
      if (owned) {
        expect(input.setBaseBranch).toHaveBeenCalledWith(undefined)
      }
    }
  )

  it('names the workspace after a branch the name field picked', () => {
    const { result } = renderHook(() =>
      useIssueSourceActions(
        createInput({ baseBranch: 'feature/export-v2', baseBranchNamesWorkspace: true })
      )
    )

    expect(result.current.smartNameSelection).toEqual({
      kind: 'branch',
      label: 'feature/export-v2'
    })
  })

  // Why: the field swaps the text input for a source pill, so a pill here would hide a typed name.
  it('claims no source for a base ref the composer picker chose, leaving a typed name on screen', () => {
    const { result } = renderHook(() =>
      useIssueSourceActions(
        createInput({
          baseBranch: 'release/1.2',
          baseBranchNamesWorkspace: false,
          name: 'my-own-name'
        })
      )
    )

    expect(result.current.smartNameSelection).toBeNull()
  })

  it('keeps a linked issue as the source whatever the base ref', () => {
    const { result } = renderHook(() =>
      useIssueSourceActions(
        createInput({
          baseBranch: 'release/1.2',
          baseBranchNamesWorkspace: false,
          linkedWorkItem: {
            type: 'issue',
            number: 42,
            title: 'Broken export',
            url: 'https://github.com/o/r/issues/42'
          } as Input['linkedWorkItem']
        })
      )
    )

    expect(result.current.smartNameSelection?.kind).toBe('github-issue')
  })
})

describe('base ref intent across a draft round trip', () => {
  it('restores a base ref chosen in the picker as a base, not as a name source', () => {
    expect(resolveDraftBaseBranchNamesWorkspace({ persistDraft: true, draftValue: false })).toBe(
      false
    )
  })

  it('restores a branch picked in the name field as a name source', () => {
    expect(resolveDraftBaseBranchNamesWorkspace({ persistDraft: true, draftValue: true })).toBe(
      true
    )
  })

  it('treats a draft written before the flag existed as a name source', () => {
    expect(
      resolveDraftBaseBranchNamesWorkspace({ persistDraft: true, draftValue: undefined })
    ).toBe(true)
  })

  it('ignores any stored intent when the composer does not persist drafts', () => {
    expect(resolveDraftBaseBranchNamesWorkspace({ persistDraft: false, draftValue: false })).toBe(
      true
    )
  })
})
