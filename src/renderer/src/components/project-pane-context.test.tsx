// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { CrossProjectPaneLayout } from './cross-project-panes/CrossProjectPaneLayout'
import { TooltipProvider } from './ui/tooltip'
import {
  addPaneProject,
  resetPanePresentation
} from './cross-project-panes/pane-presentation-test-fixture'
import { noteWorkspaceWindowRuntimeEnvironment } from '@/lib/workspace-window-runtime-scope'
import { RepositoryIconColorSection } from './settings/RepositoryIconColorSection'

vi.mock('./cross-project-panes/WorkspaceWatchingView', () => ({
  WorkspaceWatchingView: () => null
}))
beforeEach(resetPanePresentation)
afterEach(cleanup)
const mount = () =>
  render(
    <TooltipProvider>
      <CrossProjectPaneLayout />
    </TooltipProvider>
  )

it('renders owner context for inactive panes and names mixed-project tabs without changing session titles', () => {
  const alpha = addPaneProject('alpha', 'Project Alpha')
  addPaneProject('beta', 'Project Beta')
  mount()
  expect(
    screen.getByLabelText(/Project Beta.*beta branch.*beta session.*This computer/, {
      selector: '[data-pane-context]'
    })
  ).toBeTruthy()
  expect(document.querySelector('[data-project-label="Project Alpha"]')).toBeTruthy()
  expect(document.querySelector('[data-project-label="Project Beta"]')).toBeTruthy()
  act(() =>
    useAppStore
      .getState()
      .splitWindowPane(useAppStore.getState().windowPaneLayout!.activePaneId, 'horizontal')
  )
  const panes = screen.getAllByRole('region', { name: 'Workspace pane' })
  expect(
    within(panes[0]).getByLabelText(/Project Alpha.*alpha branch.*alpha session.*This computer/, {
      selector: '[data-pane-context]'
    })
  ).toBeTruthy()
  expect(within(panes[1]).getByText('Active pane')).toBeTruthy()
  act(() => addPaneProject('gamma', 'Project Gamma'))
  expect(
    within(panes[0]).getByLabelText(/Project Alpha.*alpha branch/, {
      selector: '[data-pane-context]'
    })
  ).toBeTruthy()
  expect(useAppStore.getState().getTab(alpha.id)?.label).toBe('alpha session')
})

it.each([
  ['local-loopback', 'native-runtime', 'This computer'],
  ['remote-env', 'remote-runtime', 'Build server']
])('labels runtime ownership for %s', (environmentId, runtimeId, expected) => {
  Object.assign(window, { orcaWorkspaceWindowNative: { localRuntimeId: 'native-runtime' } })
  noteWorkspaceWindowRuntimeEnvironment(environmentId, runtimeId)
  useAppStore.setState({
    runtimeEnvironments: [{ id: environmentId, name: 'Build server', runtimeId } as never]
  })
  addPaneProject('alpha', 'Project Alpha', `runtime:${environmentId}`)
  mount()
  expect(
    screen.getByLabelText(new RegExp(`Project Alpha.*${expected}`), {
      selector: '[data-pane-context]'
    })
  ).toBeTruthy()
  expect(screen.getByText('Connection unverifiable')).toBeTruthy()
})

it('keeps SSH host identity through local loopback and disconnection', () => {
  Object.assign(window, { orcaWorkspaceWindowNative: { localRuntimeId: 'native-runtime' } })
  noteWorkspaceWindowRuntimeEnvironment('loopback', 'native-runtime')
  useAppStore.setState({ sshTargetLabels: new Map([['build', 'Build SSH']]) })
  addPaneProject('alpha', 'Project Alpha', 'ssh:build')
  mount()
  expect(
    screen.getByLabelText(/Project Alpha.*Build SSH/, { selector: '[data-pane-context]' })
  ).toBeTruthy()
  expect(screen.queryByText('This computer')).toBeNull()
})

it('selects the host-qualified project and falls back to its repo when project ownership is ambiguous', () => {
  addPaneProject('shared-repo', 'Scoped repo', 'runtime:second')
  useAppStore.setState({
    projects: [
      {
        id: 'first-project',
        displayName: 'Wrong runtime project',
        sourceRepoIds: ['shared-repo']
      } as never,
      {
        id: 'second-project',
        displayName: 'Correct runtime project',
        sourceRepoIds: ['shared-repo']
      } as never
    ],
    projectHostSetups: [
      { projectId: 'first-project', repoId: 'shared-repo', hostId: 'runtime:first' } as never,
      { projectId: 'second-project', repoId: 'shared-repo', hostId: 'runtime:second' } as never
    ]
  })
  mount()
  expect(
    screen.getByLabelText(/Correct runtime project/, { selector: '[data-pane-context]' })
  ).toBeTruthy()
  expect(screen.queryByText('Wrong runtime project')).toBeNull()
  act(() =>
    useAppStore.setState({
      projectHostSetups: [
        ...useAppStore.getState().projectHostSetups,
        { projectId: 'first-project', repoId: 'shared-repo', hostId: 'runtime:second' } as never
      ]
    })
  )
  expect(screen.getByLabelText(/Scoped repo/, { selector: '[data-pane-context]' })).toBeTruthy()
})

it('preserves unresolved owner and saved session label without a local fallback', () => {
  addPaneProject('alpha', 'Project Alpha', 'runtime:missing')
  const layout = useAppStore.getState().windowPaneLayout!
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    unifiedTabsByWorktree: {},
    windowPaneLayout: layout
  })
  mount()
  expect(
    screen.getByLabelText(/alpha-workspace.*alpha session.*missing.*Unavailable/, {
      selector: '[data-pane-context]'
    })
  ).toBeTruthy()
  expect(screen.queryByText('This computer')).toBeNull()
})

it('disambiguates same-named projects with their paths in accessible context', () => {
  addPaneProject('alpha', 'A very long identical project name')
  addPaneProject('beta', 'A very long identical project name')
  mount()
  const labels = [...document.querySelectorAll('[data-project-label]')].map((el) =>
    el.getAttribute('aria-label')
  )
  expect(labels.some((label) => label?.includes('/alpha'))).toBe(true)
  expect(labels.some((label) => label?.includes('/beta'))).toBe(true)
})

it('activates a mixed tab by its project label and names unavailable mixed tabs', () => {
  addPaneProject('alpha', 'Project Alpha')
  const beta = addPaneProject('beta', 'Project Beta')
  mount()
  fireEvent.pointerDown(screen.getByText('Project Alpha'), { button: 0 })
  fireEvent.pointerUp(window, { button: 0 })
  const state = useAppStore.getState()
  expect(
    state.windowPaneLayout!.views[
      state.windowPaneLayout!.panes[state.windowPaneLayout!.activePaneId].selectedViewId!
    ].worktreeId
  ).toBe('alpha-workspace')
  expect(screen.getByRole('button', { name: /Project Alpha.*alpha session.*\/alpha/ })).toBeTruthy()
  act(() =>
    useAppStore.setState({
      unifiedTabsByWorktree: { ...state.unifiedTabsByWorktree, [beta.worktreeId]: [] }
    })
  )
  expect(
    screen.getByRole('button', { name: /Project Beta.*beta session.*Unavailable/ })
  ).toBeTruthy()
})

it('opts into a stable project accent through the existing customization and turns it off with Neutral', () => {
  addPaneProject('alpha', 'Project Alpha')
  addPaneProject('beta', 'Project Beta', 'runtime:remote')
  useAppStore.setState({
    projects: [{ id: 'shared', displayName: 'Shared project', badgeColor: '#14b8a6' } as never],
    projectHostSetups: [
      { projectId: 'shared', repoId: 'alpha', hostId: 'local' } as never,
      { projectId: 'shared', repoId: 'beta', hostId: 'runtime:remote' } as never
    ],
    repos: useAppStore.getState().repos.map((repo) => ({
      ...repo,
      badgeColor: repo.id === 'alpha' ? '#14b8a6' : '#737373'
    }))
  })
  function Customization() {
    const repo = useAppStore((state) => state.repos[1])
    return (
      <RepositoryIconColorSection
        badgeColor={repo.badgeColor}
        onBadgeColorChange={(badgeColor) => {
          useAppStore.setState((state) => ({
            repos: state.repos.map((entry) =>
              entry.id === repo.id ? { ...entry, badgeColor } : entry
            )
          }))
        }}
      />
    )
  }
  render(
    <TooltipProvider>
      <Customization />
      <CrossProjectPaneLayout />
    </TooltipProvider>
  )
  expect(document.querySelectorAll('[data-project-accent="#14b8a6"]')).toHaveLength(1)
  expect(document.querySelector('[data-pane-context] [data-project-accent]')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Use #8b5cf6 repo color' }))
  expect(document.querySelectorAll('[data-project-accent="#8b5cf6"]')).toHaveLength(2)
  expect(document.querySelector('[data-pane-context] [data-project-accent="#8b5cf6"]')).toBeTruthy()
  const state = useAppStore.getState()
  act(() => state.openAnotherWorkspaceView(state.windowPaneLayout!.activePaneId))
  const colors = [...document.querySelectorAll('[data-project-accent]')].map((element) =>
    element.getAttribute('data-project-accent')
  )
  expect(colors.length).toBeGreaterThan(2)
  expect(new Set(colors)).toEqual(new Set(['#8b5cf6', '#14b8a6']))
  fireEvent.click(screen.getByRole('button', { name: 'Neutral (accents off)' }))
  expect(document.querySelectorAll('[data-project-accent="#8b5cf6"]')).toHaveLength(0)
  expect(document.querySelectorAll('[data-project-accent="#14b8a6"]')).toHaveLength(1)
  expect(document.querySelectorAll('[data-pane-context] [data-project-accent]')).toHaveLength(0)
  expect(screen.getByText('Active pane')).toBeTruthy()
})
