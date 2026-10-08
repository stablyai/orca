// @vitest-environment happy-dom

import { useEffect, useState } from 'react'
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { resolveSmartWorkspaceCommandValue } from './smart-workspace-command-value'
import type { RowEntry } from './smart-workspace-name-field-model'
import { useSmartWorkspaceBranchIntentArm } from './use-smart-workspace-branch-intent-arm'

type Props = {
  branchNames: string[]
  branchResultsQuery: string | null
  isQueryStale: boolean
  rows: readonly RowEntry[]
  trimmedValue: string
}

// Mirrors the presentation hook: cmdk's value is controlled by the resolver's output.
function useControlledCommandValue({
  branchNames,
  branchResultsQuery,
  isQueryStale,
  rows,
  trimmedValue
}: Props) {
  const [commandValue, setCommandValue] = useState('use-name')
  const branchIntentValue = useSmartWorkspaceBranchIntentArm(
    {
      branches: branchNames.map((name) => ({ refName: name, localBranchName: name })),
      branchResultsSource: branchResultsQuery === null ? null : { query: branchResultsQuery },
      commandValue
    },
    { isQueryStale, rows, trimmedValue }
  )
  const resolved = resolveSmartWorkspaceCommandValue({
    currentValue: commandValue,
    rows,
    isQueryStale,
    sourceIntent: null,
    branchIntentValue
  })
  useEffect(() => {
    if (commandValue !== resolved) {
      setCommandValue(resolved)
    }
  }, [commandValue, resolved])
  return { resolved, setCommandValue }
}

function settled(query: string, branchNames: string[]): Props {
  return {
    branchNames,
    branchResultsQuery: query,
    isQueryStale: false,
    rows: rowsFor(query, branchNames),
    trimmedValue: query
  }
}

function rowsFor(query: string, branchNames: string[]): RowEntry[] {
  return [
    { kind: 'use-name', value: 'use-name', name: query },
    ...branchNames.map((name) => ({
      kind: 'branch' as const,
      value: `branch-${name}`,
      refName: name,
      localBranchName: name
    }))
  ]
}

describe('useSmartWorkspaceBranchIntentArm', () => {
  it('arms the branch a settled prefix names, then lets the user move back to the typed text', () => {
    const { result } = renderHook(useControlledCommandValue, {
      initialProps: settled('TV', ['TV-foo-bar'])
    })
    expect(result.current.resolved).toBe('branch-TV-foo-bar')

    act(() => result.current.setCommandValue('use-name'))
    expect(result.current.resolved).toBe('use-name')
  })

  it('re-arms the branch when the query settles again after typing', () => {
    const { result, rerender } = renderHook(useControlledCommandValue, {
      initialProps: settled('TV', ['TV-foo-bar'])
    })
    act(() => result.current.setCommandValue('use-name'))

    rerender({ ...settled('TV', ['TV-foo-bar']), isQueryStale: true, trimmedValue: 'TVx' })
    expect(result.current.resolved).toBe('use-name')

    rerender(settled('TV', ['TV-foo-bar']))
    expect(result.current.resolved).toBe('branch-TV-foo-bar')
  })

  it('keeps the typed text armed while the prefix matches several branches', () => {
    const { result } = renderHook(useControlledCommandValue, {
      initialProps: settled('TV', ['TV-foo-bar', 'TV-baz'])
    })
    expect(result.current.resolved).toBe('use-name')
  })

  it('waits for results of the current query instead of arming held results', () => {
    // "TV-f" found one branch; the "TV" search is still in flight and will find two.
    const heldResults: Props = { ...settled('TV', ['TV-foo-bar']), branchResultsQuery: 'TV-f' }
    const { result, rerender } = renderHook(useControlledCommandValue, {
      initialProps: heldResults
    })
    expect(result.current.resolved).toBe('use-name')

    rerender(settled('TV', ['TV-foo-bar', 'TV-baz']))
    expect(result.current.resolved).toBe('use-name')
  })

  it('judges uniqueness on every search result, not only the rendered rows', () => {
    const { result } = renderHook(useControlledCommandValue, {
      initialProps: {
        ...settled('TV', ['TV-foo-bar', 'TV-baz']),
        rows: rowsFor('TV', ['TV-foo-bar'])
      }
    })
    expect(result.current.resolved).toBe('use-name')
  })
})
