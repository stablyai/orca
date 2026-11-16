// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { useWorktreeContextMenuModel } from './use-worktree-context-menu-model'

afterEach(() => {
  cleanup()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

const worktree = makeWorktree({ id: 'repo1::/tmp/wt', repoId: TEST_REPO.id })
const other = makeWorktree({
  id: 'repo1::/tmp/other',
  repoId: TEST_REPO.id,
  path: '/tmp/other'
})

function renderOpenMenu() {
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree, other] },
    tabsByWorktree: { [worktree.id]: [{ id: 'tab-1' }] } as never,
    ptyIdsByTabId: {}
  })
  let renders = 0
  const hook = renderHook(() => {
    renders += 1
    return useWorktreeContextMenuModel({ worktree, children: null })
  })
  act(() => hook.result.current.setMenuOpenState(true))
  return { hook, renders: () => renders }
}

// An open menu used to subscribe to whole activity maps, so every agent status, tab or PTY write
// anywhere re-rendered the whole menu (about 200 components) while the pointer moved over it.
describe('an open workspace menu ignores store writes that change nothing it shows', () => {
  it('another workspace’s agent status, tabs and PTYs do not re-render it', () => {
    const { renders } = renderOpenMenu()
    const before = renders()
    for (let i = 0; i < 20; i += 1) {
      act(() => {
        const state = useAppStore.getState()
        useAppStore.setState({
          agentStatusByPaneKey: {
            ...state.agentStatusByPaneKey,
            [`pane-${i}`]: { updatedAt: i } as never
          },
          tabsByWorktree: {
            ...state.tabsByWorktree,
            [other.id]: [{ id: `other-${i}` }] as never
          },
          ptyIdsByTabId: {
            ...state.ptyIdsByTabId,
            [`other-${i}`]: [`pty-${i}`]
          },
          unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree },
          deleteStateByWorktreeId: { ...state.deleteStateByWorktreeId }
        })
      })
    }
    expect(renders()).toBe(before)
  })

  it('still updates live when this workspace becomes sleepable', () => {
    const { hook } = renderOpenMenu()
    expect(hook.result.current.sleepableWorktrees).toEqual([])
    act(() => useAppStore.setState({ ptyIdsByTabId: { 'tab-1': ['pty-1'] } }))
    expect(hook.result.current.sleepableWorktrees.map((item) => item.id)).toEqual([worktree.id])
  })
})
