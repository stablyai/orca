import { afterEach, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { activateWorkspacesRailItem, returnToTerminalView } from './app-rail-navigation'

const initialState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialState, true)
})

function seedWorkspacesAThenBThenTasks(): void {
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal worktree records; history liveness only reads id/repoId/path.
    worktreesByRepo: {
      repo1: [
        { id: 'repo1::/w/a', repoId: 'repo1', path: '/w/a' },
        { id: 'repo1::/w/b', repoId: 'repo1', path: '/w/b' }
      ]
    } as never,
    worktreeNavHistory: ['repo1::/w/a', 'repo1::/w/b', 'tasks'],
    worktreeNavHistoryIndex: 2,
    activeView: 'tasks',
    previousViewBeforeTasks: 'terminal',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: any non-empty task page data; the test only checks it is cleared.
    taskPageData: { preselectedRepoId: 'repo1' } as never,
    sidebarBody: 'workspaces',
    sidebarOpen: false
  })
}

it('closes Settings and then Tasks when Settings was opened over Tasks', () => {
  seedWorkspacesAThenBThenTasks()
  useAppStore.getState().openSettingsPage()
  expect(useAppStore.getState().activeView).toBe('settings')

  activateWorkspacesRailItem(useAppStore)

  const state = useAppStore.getState()
  expect(state.activeView).toBe('terminal')
  expect(state.worktreeNavHistoryIndex).toBe(1)
  expect(state.worktreeNavHistory).toEqual(['repo1::/w/a', 'repo1::/w/b', 'tasks'])
  expect(state.taskPageData).toEqual({})
  expect(state.sidebarOpen).toBe(true)
})

it('settles the cursor on the last workspace after a cyclic page chain, keeping forward history', () => {
  useAppStore.setState({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: minimal worktree records; history liveness only reads id/repoId/path.
    worktreesByRepo: { repo1: [{ id: 'repo1::/w/a', repoId: 'repo1', path: '/w/a' }] } as never,
    worktreeNavHistory: ['repo1::/w/a', 'tasks', 'automations', 'tasks'],
    worktreeNavHistoryIndex: 3,
    activeView: 'tasks',
    previousViewBeforeTasks: 'automations',
    previousViewBeforeAutomations: 'tasks'
  })
  returnToTerminalView(useAppStore)
  const state = useAppStore.getState()
  expect(state.activeView).toBe('terminal')
  expect(state.worktreeNavHistoryIndex).toBe(0)
  expect(state.worktreeNavHistory).toEqual(['repo1::/w/a', 'tasks', 'automations', 'tasks'])
})

it('keeps the cursor when no earlier workspace exists', () => {
  useAppStore.setState({
    worktreeNavHistory: ['tasks'],
    worktreeNavHistoryIndex: 0,
    activeView: 'tasks',
    previousViewBeforeTasks: 'terminal'
  })
  returnToTerminalView(useAppStore)
  expect(useAppStore.getState().activeView).toBe('terminal')
  expect(useAppStore.getState().worktreeNavHistoryIndex).toBe(0)
})

it('toggles the open workspace list from the terminal', () => {
  useAppStore.setState({ activeView: 'terminal', sidebarBody: 'workspaces', sidebarOpen: true })
  activateWorkspacesRailItem(useAppStore)
  expect(useAppStore.getState().sidebarOpen).toBe(false)
  activateWorkspacesRailItem(useAppStore)
  expect(useAppStore.getState().sidebarOpen).toBe(true)
})

it('switches an open Agents list to Workspaces without collapsing it', () => {
  useAppStore.setState({ activeView: 'terminal', sidebarBody: 'agents', sidebarOpen: true })
  activateWorkspacesRailItem(useAppStore)
  expect(useAppStore.getState()).toMatchObject({ sidebarBody: 'workspaces', sidebarOpen: true })
})
