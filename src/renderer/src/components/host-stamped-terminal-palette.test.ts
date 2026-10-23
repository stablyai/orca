// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Tab } from '../../../shared/tab-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  makeGroup,
  makeRepo,
  makeUnifiedTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'
import { buildPaletteWorktreeIndex } from '@/lib/palette-repo-resolution'
import { useWorktreeJumpPaletteOpenTabs } from './use-worktree-jump-palette-open-tabs'
import { useWorktreeJumpPaletteStoreState } from './use-worktree-jump-palette-store-state'
import {
  buildOpenTabSearchEntries,
  selectOpenTabSearchAgentState,
  selectOpenTabSearchEntryState
} from './tab-bar/open-tab-search-entries'

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: () => true }))

import { activateWorkspaceTabPaletteResult } from '@/lib/workspace-tab-palette-activation'

const WT = 'wt-local'
const initialState = useAppStore.getInitialState()

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

const localWorktree: Worktree = makeWorktree(WT, 'Local workspace', { hostId: 'local' })
const stamped: Tab = {
  ...makeUnifiedTab('host-tab', WT, 'host-tab', 'Host terminal'),
  executionHostId: 'runtime:env-b',
  projectHostSetupId: 'setup-b'
}

function seed(worktrees: Worktree[], tab: Tab = stamped): void {
  useAppStore.setState({
    ...initialState,
    worktreesByRepo: { 'repo-1': worktrees },
    groupsByWorktree: { [WT]: [makeGroup(WT, [tab.id])] },
    activeGroupIdByWorktree: { [WT]: `group-${WT}` },
    unifiedTabsByWorktree: { [WT]: [tab] }
  })
}

const runtimeOwned = { ...localWorktree, runtimeOwnerEnvironmentId: 'hub' }

describe('host-stamped terminal in the Cmd+J palette', () => {
  function renderPalette() {
    const { result } = renderHook(() => {
      const storeState = useWorktreeJumpPaletteStoreState({ visible: true, lingering: false })
      return useWorktreeJumpPaletteOpenTabs({
        ...storeState,
        workspaces: [localWorktree],
        hasQuery: true,
        isLoading: false,
        visibleWorktreesForState: [localWorktree],
        switchableWorktreesForRows: [localWorktree],
        searchScopeWorktrees: [localWorktree],
        browserSortedWorktrees: [localWorktree],
        worktreeMap: new Map([[WT, localWorktree]]),
        resolveWorktree: () => localWorktree,
        paletteWorktreeIndex: buildPaletteWorktreeIndex([localWorktree]),
        worktreeOrder: new Map([[WT, 0]]),
        worktreeMatches: [],
        repoMap: new Map(),
        repoByHostIdentity: new Map(),
        deferredQuery: 'Host terminal',
        paletteSearchContext: { nowMs: 0 }
      })
    })
    return () =>
      result.current.workspaceTabEntries.map((entry) => [entry.tab.id, entry.tab.executionHostId])
  }

  it('lists the terminal for a positively local source, then drops it when provenance flips', () => {
    seed([localWorktree])
    const entries = renderPalette()
    expect(entries()).toEqual([['host-tab', 'runtime:env-b']])

    // Why no rerender props: the proof must come from a reactive store subscription.
    act(() => useAppStore.setState({ worktreesByRepo: { 'repo-1': [runtimeOwned] } }))
    expect(entries()).toEqual([])
  })

  it('keeps an ambiguous source out of the palette', () => {
    seed([localWorktree, localWorktree])
    expect(renderPalette()()).toEqual([])
  })

  it('keeps an invalid stamp out of the palette', () => {
    seed([localWorktree], { ...stamped, executionHostId: 'local' })
    expect(renderPalette()()).toEqual([])
  })
})

describe('host-stamped terminal in the tab-bar open-tab search', () => {
  function entries(): string[] {
    const state = useAppStore.getState()
    const selected = selectOpenTabSearchEntryState(state, WT)
    return selected
      ? buildOpenTabSearchEntries(selected, selectOpenTabSearchAgentState(state)).workspaceTabs.map(
          (entry) => entry.tab.id
        )
      : []
  }

  it('carries positive local proof as a primitive and follows a provenance flip', () => {
    seed([localWorktree])
    expect(selectOpenTabSearchEntryState(useAppStore.getState(), WT)?.isLocalSource).toBe(true)
    expect(entries()).toEqual(['host-tab'])

    useAppStore.setState({ worktreesByRepo: { 'repo-1': [runtimeOwned] } })
    expect(selectOpenTabSearchEntryState(useAppStore.getState(), WT)?.isLocalSource).toBe(false)
    expect(entries()).toEqual([])
  })
})

describe('host-stamped terminal palette activation', () => {
  const target = {
    worktreeId: WT,
    groupId: `group-${WT}`,
    tabId: 'host-tab',
    entityId: 'host-tab',
    contentType: 'terminal' as const
  }

  it('activates with positive local proof', () => {
    seed([localWorktree])
    expect(activateWorkspaceTabPaletteResult(target)).toEqual({ status: 'activated' })
  })

  it.each([
    ['runtime-owner provenance', [runtimeOwned]],
    ['an ambiguous source', [localWorktree, localWorktree]]
  ])('refuses %s', (_label, worktrees) => {
    seed(worktrees)
    expect(activateWorkspaceTabPaletteResult(target)).toMatchObject({ status: 'failed' })
  })

  it('refuses repo-level runtime provenance', () => {
    seed([{ ...localWorktree, hostId: undefined }])
    useAppStore.setState({
      repos: [{ ...makeRepo(), executionHostId: 'runtime:hub' }]
    })
    expect(activateWorkspaceTabPaletteResult(target)).toMatchObject({ status: 'failed' })
  })
})
