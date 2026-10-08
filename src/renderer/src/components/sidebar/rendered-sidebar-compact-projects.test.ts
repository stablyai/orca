import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getDefaultSettings } from '../../../../shared/constants'
import { computeRenderedSidebarRows } from './rendered-sidebar-worktree-order'
import {
  getVisibleWorktreeShortcutTargets,
  setVisibleWorktreeIds,
  setVisibleWorktreeShortcutTargets
} from './visible-worktrees'
import {
  worktree as worktreeFixture,
  repo as repoFixture
} from './worktree-list-groups-test-fixtures'

const initialState = useAppStore.getInitialState()
const repoA: Repo = { ...repoFixture, id: 'repo-a', path: '/tmp/a', displayName: 'alpha' }
const repoB: Repo = { ...repoFixture, id: 'repo-b', path: '/tmp/b', displayName: 'beta' }

function wt(id: string, repoId: string, isMainWorktree = false): Worktree {
  return { ...worktreeFixture, id, repoId, path: `/tmp/${id}`, displayName: id, isMainWorktree }
}

const a = wt('wt-a', repoA.id, true)
const b1 = wt('wt-b1', repoB.id, true)
const b2 = wt('wt-b2', repoB.id)

function seed(activeWorktreeId: string): void {
  useAppStore.setState(initialState, true)
  useAppStore.setState({
    repos: [repoA, repoB],
    worktreesByRepo: { [repoA.id]: [a], [repoB.id]: [b1, b2] },
    showSleepingWorkspaces: true,
    groupBy: 'repo',
    sortBy: 'manual',
    projectOrderBy: 'manual',
    activeWorktreeId,
    settings: { ...getDefaultSettings('/tmp'), compactProjectRows: true }
  })
  setVisibleWorktreeIds(null)
  setVisibleWorktreeShortcutTargets(null)
}

describe('compact project rows outside the mounted list', () => {
  afterEach(() => {
    setVisibleWorktreeIds(null)
    setVisibleWorktreeShortcutTargets(null)
    useAppStore.setState(initialState, true)
  })

  it('replays the accordion: folded projects render one row, the active one lists its cards', () => {
    seed('wt-a')
    const folded = computeRenderedSidebarRows(useAppStore.getState(), [a, b1, b2])
    expect(folded.map((row) => row.type)).toEqual(['item', 'header'])

    seed('wt-b2')
    const open = computeRenderedSidebarRows(useAppStore.getState(), [a, b1, b2])
    expect(open.map((row) => row.type)).toEqual(['item', 'header', 'item', 'item'])
  })

  it('numbers projects, not cards, so Cmd+1–9 stays stable as the accordion moves', () => {
    seed('wt-a')
    const whileFolded = getVisibleWorktreeShortcutTargets()
    seed('wt-b2')
    const whileOpen = getVisibleWorktreeShortcutTargets()
    expect(whileFolded).toEqual(whileOpen)
    expect(whileOpen.map((target) => target.projectWorktreeIds ?? target.id)).toEqual([
      'wt-a',
      ['wt-b1', 'wt-b2']
    ])
  })
})
