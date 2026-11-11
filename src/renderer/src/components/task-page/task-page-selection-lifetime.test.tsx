// @vitest-environment happy-dom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import { TooltipProvider } from '../ui/tooltip'
import { useTaskPageRepoSelection } from './use-task-page-repo-selection'
import type { TaskPageStoreBindingsModel } from './use-task-page-store-bindings'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageGitHubModeControls } from './github/ModeControls'

const originalState = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const first: Repo = {
  id: 'a',
  path: '/a',
  displayName: 'Alpha',
  kind: 'git',
  badgeColor: '',
  addedAt: 0,
  upstream: { owner: 'org', repo: 'alpha' }
}
const second: Repo = {
  ...first,
  id: 'b',
  path: '/b',
  displayName: 'Beta',
  upstream: { owner: 'org', repo: 'beta' }
}
const remote: Repo = { ...first, path: '/remote/a', executionHostId: 'runtime:server' }

function install(settings: GlobalSettings | null) {
  const projection = projectHostSetupProjectionFromRepos([first, second, remote])
  const save = vi.fn(async (updates: Partial<GlobalSettings>) => ({
    ...getDefaultSettings(''),
    ...useAppStore.getState().settings,
    ...updates
  }))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { settings: { set: save }, shell: { openUrl: vi.fn() } }
  })
  useAppStore.setState({
    settings,
    repos: [first, second, remote],
    projects: projection.projects,
    projectHostSetups: projection.setups,
    taskPageData: { preselectedRepoId: 'a' }
  })
  return save
}
function Harness() {
  const state = useAppStore(
    useShallow((s) => ({
      settings: s.settings,
      repos: s.repos,
      pageData: s.taskPageData,
      updateSettings: s.updateSettings
    }))
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: selection reads only these settings, entry, catalog and inactive-provider fields.
  const selection = useTaskPageRepoSelection({
    ...state,
    linearStatus: {},
    jiraStatus: {}
  } as unknown as TaskPageStoreBindingsModel)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rendered GitHub controls consume this actual selection plus the supplied inactive-mode and host-label fields.
  const model = {
    ...selection,
    taskSource: 'github',
    projectModeVisible: false,
    githubModeButtons: [],
    getTaskPickerRepoHostLabel: (repo: Repo) =>
      repo.executionHostId === 'runtime:server' ? 'Server' : 'Local'
  } as unknown as TaskPageComposerActionsModel
  return (
    <TooltipProvider>
      <TaskPageGitHubModeControls model={model} />
      <output data-testid="selected">{[...selection.repoSelection].sort().join('|')}</output>
    </TooltipProvider>
  )
}
afterEach(() => {
  cleanup()
  useAppStore.setState(originalState, true)
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it('keeps real picker edits and All through saved publication, then honors a new concrete entry and consumes detail context without retargeting', async () => {
  const save = install({ ...getDefaultSettings(''), defaultRepoSelection: null })
  const user = userEvent.setup()
  render(<Harness />)
  expect(screen.getByTestId('selected').textContent).toBe('local\0a')
  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('button', { name: /^Beta/ }))
  await waitFor(() =>
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultRepoSelection: ['local\0a', 'local\0b'] })
    )
  )
  await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('local\0a|local\0b'))
  await user.click(screen.getByRole('button', { name: /^Alpha/ }))
  await waitFor(() => expect(screen.getByTestId('selected').textContent).toBe('local\0b'))
  await user.click(screen.getByRole('button', { name: 'All projects' }))
  await waitFor(() => expect(useAppStore.getState().settings?.defaultRepoSelection).toBeNull())
  expect(screen.getByTestId('selected').textContent).toBe('local\0a|local\0b')
  const context = {
    kind: 'task-source',
    provider: 'github',
    projectId: 'github:org/alpha',
    hostId: 'runtime:server',
    repoId: 'a'
  } as const
  act(() =>
    useAppStore.setState({
      taskPageData: { preselectedRepoId: 'a', openGitHubSourceContext: context }
    })
  )
  expect(screen.getByTestId('selected').textContent).toBe('runtime:server\0a')
  await user.click(screen.getByRole('button', { name: /^Beta/ }))
  await waitFor(() =>
    expect(screen.getByTestId('selected').textContent).toBe('local\0b|runtime:server\0a')
  )
  act(() =>
    useAppStore.setState({
      taskPageData: { preselectedRepoId: 'a', openGitHubSourceContext: { ...context } }
    })
  )
  expect(screen.getByTestId('selected').textContent).toBe('local\0b|runtime:server\0a')
  act(() => useAppStore.setState({ taskPageData: { preselectedRepoId: 'a' } }))
  expect(screen.getByTestId('selected').textContent).toBe('local\0b|runtime:server\0a')
  act(() => useAppStore.setState({ taskPageData: { preselectedRepoId: 'b' } }))
  expect(screen.getByTestId('selected').textContent).toBe('local\0b')
})

it('adopts the first loaded default only until a picker edit owns the current generic entry', async () => {
  install(null)
  useAppStore.setState({ taskPageData: {} })
  const user = userEvent.setup()
  render(<Harness />)
  act(() =>
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), defaultRepoSelection: ['runtime:server\0a'] }
    })
  )
  expect(screen.getByTestId('selected').textContent).toBe('runtime:server\0a')
  await user.click(screen.getByRole('combobox'))
  await user.click(screen.getByRole('button', { name: /^Beta/ }))
  await waitFor(() =>
    expect(screen.getByTestId('selected').textContent).toBe('local\0b|runtime:server\0a')
  )
  act(() =>
    useAppStore.setState({
      settings: { ...getDefaultSettings(''), defaultRepoSelection: ['local\0a'] }
    })
  )
  expect(screen.getByTestId('selected').textContent).toBe('local\0b|runtime:server\0a')
})
