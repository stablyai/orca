// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWorktreeAgentExpansionStateForTests,
  expandWorktreeAgentList,
  useWorktreeAgentExpansionState
} from './worktree-card-agents-expansion-state'

const WS = 'repo1::/path/a'

afterEach(() => {
  clearWorktreeAgentExpansionStateForTests()
})

describe('worktree agent expansion state', () => {
  it('keeps disclosure separate for same-ID workspaces on different hosts', () => {
    const local = renderHook(() => useWorktreeAgentExpansionState(WS, 'local'))
    const remote = renderHook(() => useWorktreeAgentExpansionState(WS, 'runtime:box'))

    act(() => {
      local.result.current.toggleCompactRootList()
      local.result.current.toggleLineageParent('tab:pane')
    })

    expect(local.result.current.compactRootListExpanded).toBe(true)
    expect([...local.result.current.expandedLineageParents]).toEqual(['tab:pane'])
    expect(remote.result.current.compactRootListExpanded).toBe(false)
    expect(remote.result.current.expandedLineageParents.size).toBe(0)
  })

  it('unfolds only the jumped-to host’s card', () => {
    const local = renderHook(() => useWorktreeAgentExpansionState(WS, 'local'))
    const remote = renderHook(() => useWorktreeAgentExpansionState(WS, 'runtime:box'))

    act(() => expandWorktreeAgentList(WS, 'runtime:box'))

    expect(remote.result.current.compactRootListExpanded).toBe(true)
    expect(local.result.current.compactRootListExpanded).toBe(false)
  })

  it('treats an unstamped host as local, matching the card’s slot targets', () => {
    const unstamped = renderHook(() => useWorktreeAgentExpansionState(WS, undefined))

    act(() => expandWorktreeAgentList(WS, 'local'))

    expect(unstamped.result.current.compactRootListExpanded).toBe(true)
  })
})
