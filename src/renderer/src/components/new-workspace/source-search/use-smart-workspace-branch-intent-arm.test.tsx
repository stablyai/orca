// @vitest-environment happy-dom

import { useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { RowEntry } from '../name-field/smart-workspace-name-field-model'
import { useSmartWorkspaceBranchIntentArm } from './use-smart-workspace-branch-intent-arm'
import { useWorkItemSourcePresentation } from './use-work-item-source-presentation'

function rowsFor(query: string, branchRefs: string[]): RowEntry[] {
  return [
    { kind: 'use-name', value: 'use-name', name: query },
    ...branchRefs.map((refName) => ({
      kind: 'branch' as const,
      value: `branch-${refName}`,
      refName,
      localBranchName: refName.replace(/^refs\/remotes\/origin\//, '')
    }))
  ]
}

function makeBranches(branchRefs: string[]) {
  return branchRefs.map((refName) => ({
    refName,
    localBranchName: refName.replace(/^refs\/remotes\/origin\//, '')
  }))
}

describe('useSmartWorkspaceBranchIntentArm', () => {
  it('arms a unique branch once per settled query and re-arms after typing makes the query stale', () => {
    const branchRefs = ['refs/remotes/origin/TV-foo-bar']
    const rows = rowsFor('origin/TV', branchRefs)
    const { result, rerender } = renderHook(
      ({
        commandValue,
        isQueryStale,
        trimmedValue,
        branchResultsRepoId = 'repo-1',
        branchResultsQuery = 'origin/TV'
      }: {
        commandValue: string
        isQueryStale: boolean
        trimmedValue: string
        branchResultsRepoId?: string
        branchResultsQuery?: string | null
      }) =>
        useSmartWorkspaceBranchIntentArm(
          {
            branches: makeBranches(branchRefs),
            branchResultsSource:
              branchResultsQuery === null
                ? null
                : { repoId: branchResultsRepoId, query: branchResultsQuery },
            commandValue,
            selectedRepo: { id: 'repo-1' }
          },
          { isQueryStale, rows, trimmedValue }
        ),
      {
        initialProps: {
          commandValue: 'use-name',
          isQueryStale: false,
          trimmedValue: 'origin/TV'
        }
      }
    )

    expect(result.current).toBe('branch-refs/remotes/origin/TV-foo-bar')

    rerender({
      commandValue: 'branch-refs/remotes/origin/TV-foo-bar',
      isQueryStale: false,
      trimmedValue: 'origin/TV'
    })
    expect(result.current).toBeNull()

    rerender({
      commandValue: 'use-name',
      isQueryStale: false,
      trimmedValue: 'origin/TV'
    })
    expect(result.current).toBeNull()

    rerender({
      commandValue: 'use-name',
      isQueryStale: true,
      trimmedValue: 'origin/TVx'
    })
    expect(result.current).toBeNull()

    rerender({
      commandValue: 'use-name',
      isQueryStale: false,
      trimmedValue: 'origin/TV'
    })
    expect(result.current).toBe('branch-refs/remotes/origin/TV-foo-bar')
  })

  it('returns null when multiple branches match or results came from another repo', () => {
    const multiRefs = ['refs/remotes/origin/TV-foo-bar', 'refs/remotes/origin/TV-baz']
    const { result, rerender } = renderHook(
      ({
        branchRefs,
        branchResultsRepoId
      }: {
        branchRefs: string[]
        branchResultsRepoId: string
      }) =>
        useSmartWorkspaceBranchIntentArm(
          {
            branches: makeBranches(branchRefs),
            branchResultsSource: { repoId: branchResultsRepoId, query: 'origin/TV' },
            commandValue: 'use-name',
            selectedRepo: { id: 'repo-1' }
          },
          {
            isQueryStale: false,
            rows: rowsFor('origin/TV', branchRefs),
            trimmedValue: 'origin/TV'
          }
        ),
      {
        initialProps: { branchRefs: multiRefs, branchResultsRepoId: 'repo-1' }
      }
    )
    expect(result.current).toBeNull()

    rerender({
      branchRefs: ['refs/remotes/origin/TV-foo-bar'],
      branchResultsRepoId: 'repo-other'
    })
    expect(result.current).toBeNull()
  })
})

describe('useWorkItemSourcePresentation branch-intent wiring', () => {
  it('arms the unique branch in presentation output and respects manual move back to use-name', () => {
    function usePresentationHarness({
      value,
      debouncedQuery
    }: {
      value: string
      debouncedQuery: string
    }) {
      const [commandValue, setCommandValue] = useState('use-name')
      const presentation = useWorkItemSourcePresentation({
        branches: makeBranches(['refs/remotes/origin/TV-foo-bar']),
        mode: 'smart',
        branchResultsSource: { repoId: 'repo-1', query: debouncedQuery },
        selectedRepo: { id: 'repo-1' },
        value,
        githubItems: [],
        debouncedQuery,
        gitlabSourceAvailable: false,
        gitlabItems: [],
        jiraIssues: [],
        linearAvailable: false,
        linearStatusChecked: true,
        linearIssues: [],
        commandValue,
        setCommandValue,
        githubLoading: false,
        gitlabLoading: false,
        branchesLoading: false,
        linearLoading: false,
        jiraLoading: false,
        linearUrlLoadingFeedbackQuery: null,
        settledLinearUrlQuery: null,
        typedTextEnabled: true,
        jiraSource: {
          intent: false,
          loading: false,
          issue: null,
          accountChoices: [],
          selectAccount: vi.fn(),
          boundSourceContext: null
        }
      })
      return {
        resolvedCommandValue: presentation.resolvedCommandValue,
        setCommandValue
      }
    }

    const { result, rerender } = renderHook(usePresentationHarness, {
      initialProps: { value: 'origin/TV', debouncedQuery: 'origin/TV' }
    })

    expect(result.current.resolvedCommandValue).toBe('branch-refs/remotes/origin/TV-foo-bar')

    act(() => result.current.setCommandValue('use-name'))
    expect(result.current.resolvedCommandValue).toBe('use-name')

    rerender({ value: 'origin/TVx', debouncedQuery: 'origin/TV' })
    expect(result.current.resolvedCommandValue).toBe('use-name')

    rerender({ value: 'origin/TV', debouncedQuery: 'origin/TV' })
    expect(result.current.resolvedCommandValue).toBe('branch-refs/remotes/origin/TV-foo-bar')
  })
})
