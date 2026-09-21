// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { useWorktreeJumpPaletteWorktrees } from './use-worktree-jump-palette-worktrees'
import { makeRepo, makeTerminalTab, makeWorktree } from './worktree-jump-palette-test-fixtures'

afterEach(cleanup)

type Input = Parameters<typeof useWorktreeJumpPaletteWorktrees>[0]

function makeInput(): Input {
  const repo = makeRepo()
  const worktrees = [
    makeWorktree('sleeping', 'Sleeping'),
    makeWorktree('awake', 'Awake'),
    makeWorktree('remote', 'Remote', { hostId: 'ssh:box' }),
    makeWorktree('other', 'Other', { repoId: 'other-repo' }),
    makeWorktree('main', 'Main', { isMainWorktree: true, branch: '', head: '' })
  ]
  return {
    ...useAppStore.getInitialState(),
    visible: true,
    paletteNowMs: 1000,
    paletteStatusInputsActive: true,
    statusInputsLingering: false,
    pluginCommands: [],
    settingsSections: [],
    workspacePortScan: null,
    repos: [repo],
    allWorktrees: worktrees,
    worktreesByRepo: { [repo.id]: worktrees },
    hideSleepingProjectKeys: ['local\0repo-1'],
    showSleepingWorkspaces: true,
    alwaysShowDefaultBranchWorkspace: true,
    tabsByWorktree: { awake: [makeTerminalTab('tab', 'awake', 'Terminal')] },
    ptyIdsByTabId: { tab: ['pty'] },
    paletteSearchQuery: '',
    paletteSearchContext: { nowMs: 1000 },
    repoMap: new Map([[repo.id, repo]]),
    repoByHostIdentity: new Map([['local\0repo-1', repo]]),
    filterPredicate: null,
    hostOptions: [],
    hostFilterActive: false
  }
}

it('filters the selected project and host, preserves active/primary rows, and responds to toggles', () => {
  const input = makeInput()
  const { result, rerender } = renderHook(useWorktreeJumpPaletteWorktrees, { initialProps: input })
  const ids = () => result.current.visibleWorktreesForState.map((worktree) => worktree.id).sort()
  expect(ids()).toEqual(['awake', 'main', 'other', 'remote'])

  rerender({ ...input, hideSleepingProjectKeys: [] })
  expect(ids()).toEqual(['awake', 'main', 'other', 'remote', 'sleeping'])

  rerender({ ...input, hideSleepingProjectKeys: [], showSleepingWorkspaces: false })
  expect(ids()).toEqual(['awake', 'main'])

  rerender({ ...input, alwaysShowDefaultBranchWorkspace: false })
  expect(ids()).toEqual(['awake', 'other', 'remote'])
})

it('still allows an explicit search to discover sleeping worktrees', () => {
  const { result } = renderHook(useWorktreeJumpPaletteWorktrees, {
    initialProps: { ...makeInput(), paletteSearchQuery: 'Sleeping' }
  })
  expect(result.current.searchScopeWorktrees.map((worktree) => worktree.id)).toContain('sleeping')
  expect(result.current.worktreeMatches.length).toBeGreaterThan(0)
})
