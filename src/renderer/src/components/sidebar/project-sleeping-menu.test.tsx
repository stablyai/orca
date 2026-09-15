// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useWorkspaceOptionsFilterBadge } from './workspace-options-menu-items'
import { makeRepo } from '../worktree-jump-palette-test-fixtures'
import { RepoHeaderProjectActionsMenu } from './worktree-list/rows/repo-header-project-actions'

const initialState = useAppStore.getInitialState()
const setUI = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  useAppStore.setState(initialState, true)
  Object.defineProperty(window, 'api', { value: { ui: { set: setUI } }, configurable: true })
  setUI.mockClear()
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
})

it('toggles only this project from its actions menu and persists the selection', () => {
  const repo = makeRepo()
  useAppStore.setState({ hideSleepingProjectKeys: ['ssh:box\0repo-1'] })
  render(
    <TooltipProvider>
      <RepoHeaderProjectActionsMenu
        repo={repo}
        label={repo.displayName}
        projectGroups={[]}
        actions={{
          getWorktreeVisibilityDefaults: () => undefined,
          onOpenRepoSettings: vi.fn(),
          onOpenWorktreeVisibility: vi.fn(),
          onCreateGroupFromRepo: vi.fn(),
          onMoveProjectToGroup: vi.fn(),
          onRemoveProjectFromGroup: vi.fn(),
          onRemoveProject: vi.fn(),
          onCreateForRepo: vi.fn()
        }}
      />
    </TooltipProvider>
  )
  const open = () =>
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Project actions for Repo 1' }), {
      button: 0,
      ctrlKey: false
    })
  open()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Hide sleeping worktrees' }))
  expect(useAppStore.getState().hideSleepingProjectKeys).toEqual([
    'ssh:box\0repo-1',
    'local\0repo-1'
  ])
  expect(setUI).toHaveBeenLastCalledWith({
    hideSleepingProjectKeys: ['ssh:box\0repo-1', 'local\0repo-1']
  })
  open()
  expect(screen.queryByRole('menuitemcheckbox')).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Show sleeping worktrees' }))
  expect(useAppStore.getState().hideSleepingProjectKeys).toEqual(['ssh:box\0repo-1'])
})

it('counts global filters without counting project sleeping preferences', () => {
  const { result } = renderHook(() => useWorkspaceOptionsFilterBadge())
  const initialCount = result.current.activeFilterCount
  const initialHasFilter = result.current.hasAnyFilter
  act(() => useAppStore.setState({ hideSleepingProjectKeys: ['local\0repo-1'] }))
  expect(result.current.activeFilterCount).toBe(initialCount)
  expect(result.current.hasAnyFilter).toBe(initialHasFilter)
  act(() => useAppStore.setState({ showSleepingWorkspaces: false }))
  expect(result.current.activeFilterCount).toBe(initialCount + 1)
})
