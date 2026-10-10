// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { getRepoMapFromState } from '@/store/selectors'
import type { FilterAgentIds } from '../../../../../../shared/workspace-agent-filter'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import { buildVisibleWorktreeOptionsFromState } from '../../visible-worktree-options-from-state'
import { computeVisibleWorktrees } from '../../visible-worktrees'
import { useSidebarWorktreeFilters } from './use-filters'

const initialState = useAppStore.getInitialState()
const originalApi = window.api
const claudeOnly: FilterAgentIds = ['claude']

function visibleIds(): string[] {
  const state = useAppStore.getState()
  return computeVisibleWorktrees(
    state.worktreesByRepo,
    [],
    buildVisibleWorktreeOptionsFromState(state, getRepoMapFromState(state))
  ).map((worktree) => worktree.id)
}

describe('revealWorkspaceFilters agent scope', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test only calls ui.set, and the spread keeps the rest of the preload API.
    window.api = {
      ...originalApi,
      ui: {
        ...originalApi?.ui,
        set: vi.fn().mockResolvedValue(undefined)
      }
    } as typeof window.api
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    window.api = originalApi
  })

  it('adds the hidden workspace agent so reveal shows it', () => {
    const repo = makeRepo()
    const shown = makeWorktree('wt-claude', 'Claude', { createdWithAgent: 'claude' })
    const hidden = makeWorktree('wt-codex', 'Codex', { createdWithAgent: 'codex' })
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [shown, hidden] },
      filterAgentIds: claudeOnly,
      showSleepingWorkspaces: true
    })

    const { result } = renderHook(() => useSidebarWorktreeFilters())
    expect(visibleIds()).toEqual(['wt-claude'])

    act(() => {
      result.current.revealWorkspaceFilters(hidden)
    })

    expect(useAppStore.getState().filterAgentIds).toEqual(['claude', 'codex'])
    expect(visibleIds()).toEqual(['wt-claude', 'wt-codex'])
  })

  it('clears the agent filter when the hidden workspace has no agent evidence', () => {
    const repo = makeRepo()
    const shown = makeWorktree('wt-claude', 'Claude', { createdWithAgent: 'claude' })
    const hidden = makeWorktree('wt-empty', 'Empty')
    useAppStore.setState({
      repos: [repo],
      worktreesByRepo: { [repo.id]: [shown, hidden] },
      filterAgentIds: claudeOnly,
      showSleepingWorkspaces: true
    })

    const { result } = renderHook(() => useSidebarWorktreeFilters())
    act(() => {
      result.current.revealWorkspaceFilters(hidden)
    })

    expect(useAppStore.getState().filterAgentIds).toBeNull()
    expect(visibleIds()).toEqual(['wt-claude', 'wt-empty'])
  })
})
