// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  within,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Toaster } from 'sonner'
import { useAppStore } from '@/store'
import { CrossProjectPaneLayout } from './cross-project-panes/CrossProjectPaneLayout'
import { useWindowPaneNavigation } from './cross-project-panes/use-window-pane-navigation'
import {
  addPaneProject,
  resetPanePresentation
} from './cross-project-panes/pane-presentation-test-fixture'
import { TooltipProvider } from './ui/tooltip'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '@/runtime/runtime-compatibility-test-fixture'
import { useSourceControlWorktreeContext } from './right-sidebar/source-control/listing/use-worktree-context'
import { useSourceControlStatusRefresh } from './right-sidebar/source-control/sync/use-status-refresh'
import { buildRuntimeSessionPlaceholders } from '@/store/terminals/workspace-terminal-placeholders'
import { mergeFetchedReposForHost } from '@/store/repos/repo-catalog-identity'

beforeEach(resetPanePresentation)
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function Panes() {
  useWindowPaneNavigation()
  return (
    <TooltipProvider>
      <CrossProjectPaneLayout />
    </TooltipProvider>
  )
}

it.each([
  ['folder', false],
  ['git', false],
  ['folder', true],
  [undefined, true]
] as const)(
  'waits for the restored owner catalog before %s source-control requests (placeholder: %s)',
  async (kind, placeholder) => {
    addPaneProject('delayed', 'Delayed project', 'runtime:delayed')
    const repo = useAppStore.getState().repos[0]
    useAppStore.setState({
      repos: placeholder
        ? buildRuntimeSessionPlaceholders({
            repos: [],
            worktreesByRepo: {},
            runtimeHostIdByWorkspaceSessionKey: { [`${repo.id}::${repo.path}`]: 'runtime:delayed' }
          }).repos
        : [],
      activeRepoId: repo.id,
      settings: { activeRuntimeEnvironmentId: null } as never
    })
    const status = {
      entries: [],
      conflictOperation: 'unknown',
      upstreamStatus: { hasUpstream: false, ahead: 0, behind: 0 }
    }
    const localStatus = vi.fn().mockResolvedValue(status)
    const runtimeCall = vi.fn(
      async (request) =>
        createCompatibleRuntimeStatusResponseIfNeeded(request) ?? { ok: true, result: status }
    )
    Object.assign(window.api, {
      git: { ...window.api.git, status: localStatus },
      runtimeEnvironments: { call: runtimeCall }
    })
    const { result } = renderHook(() => {
      const context = useSourceControlWorktreeContext()
      return useSourceControlStatusRefresh({
        ...context,
        activePushTarget: context.activeWorktree?.pushTarget
      })
    })
    await act(() => result.current.refreshActiveGitStatus())
    expect(localStatus).not.toHaveBeenCalled()
    expect(runtimeCall).not.toHaveBeenCalled()
    act(() =>
      useAppStore.setState({
        repos: [
          ...mergeFetchedReposForHost(
            useAppStore.getState().repos,
            [{ ...repo, kind }],
            'runtime:delayed'
          )
        ]
      })
    )
    await act(() => result.current.refreshActiveGitStatus())
    expect(localStatus).not.toHaveBeenCalled()
    if (kind === 'folder') {
      expect(runtimeCall).not.toHaveBeenCalled()
    } else {
      expect(runtimeCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'delayed',
          method: 'git.status',
          params: expect.objectContaining({ worktree: 'id:delayed-workspace' })
        })
      )
    }
  }
)

it('explains an older host rejection without creating a local terminal or changing global navigation', async () => {
  addPaneProject('legacy', 'Legacy project', 'runtime:legacy')
  useAppStore.setState({
    worktreesByRepo: {
      legacy: useAppStore
        .getState()
        .worktreesByRepo.legacy.map((worktree) => ({ ...worktree, branch: 'main' }))
    }
  })
  const runtimeCall = vi.fn(async (request) => {
    if (request.method === 'status.get') {
      return { ok: true, result: { capabilities: [], hostPlatform: 'linux' } }
    }
    throw new Error('workspace_window_navigation_unsupported')
  })
  Object.assign(window.api, { runtimeEnvironments: { call: runtimeCall } })
  useAppStore.setState({ runtimeEnvironments: [{ id: 'legacy', name: 'Legacy host' } as never] })
  const before = useAppStore.getState().windowPaneLayout
  vi.spyOn(useAppStore.getState(), 'refreshGitHubForWorktreeIfStale').mockImplementation(() => {})
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  render(
    <>
      <Panes />
      <Toaster />
    </>
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'New tab' }), { button: 0 })
  fireEvent.click(await screen.findByRole('menuitem', { name: /^New Terminal/ }))
  await waitFor(() =>
    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'legacy', method: 'session.tabs.createTerminal' })
    )
  )
  expect(
    await screen.findByText(
      'This host does not support independent window navigation. Update Orca on the host.'
    )
  ).toBeTruthy()
  expect(
    runtimeCall.mock.calls
      .map(([request]) => request.method)
      .filter((method: string) => method.startsWith('session.'))
  ).toEqual(['session.tabs.createTerminal'])
  expect(runtimeCall).toHaveBeenCalledWith(
    expect.objectContaining({ selector: 'legacy', method: 'session.tabs.createTerminal' })
  )
  expect(useAppStore.getState().windowPaneLayout).toEqual(before)
  expect(window.api.pty.spawn).not.toHaveBeenCalled()
  expect(window.api.pty.kill).not.toHaveBeenCalled()
  expect(warning).toHaveBeenCalledWith(
    '[web-runtime-session] failed to create terminal:',
    'workspace_window_navigation_unsupported'
  )
})

it.each([true, false])(
  'selects the requested host with duplicate owner IDs when the previous view is resolved: %s',
  (resolved) => {
    const first = addPaneProject('same', 'First project', 'runtime:first')
    const state = useAppStore.getState()
    useAppStore.setState({
      runtimeEnvironments: [
        { id: 'first', name: 'First host' } as never,
        { id: 'second', name: 'Second host' } as never
      ],
      repos: [
        ...state.repos,
        { ...state.repos[0], displayName: 'Second project', executionHostId: 'runtime:second' }
      ],
      worktreesByRepo: {
        same: [
          ...state.worktreesByRepo.same,
          { ...state.worktreesByRepo.same[0], hostId: 'runtime:second' }
        ]
      },
      unifiedTabsByWorktree: {
        [first.worktreeId]: [
          ...(resolved ? [first] : []),
          { ...first, executionHostId: 'runtime:second', label: 'Second session' }
        ]
      }
    })
    render(<Panes />)
    expect(
      screen.getByLabelText(/First project.*First host/, { selector: '[data-pane-context]' })
    ).toBeTruthy()
    act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:second' }))
    expect(
      screen.getByLabelText(/Second project.*Second session.*Second host/, {
        selector: '[data-pane-context]'
      })
    ).toBeTruthy()
    expect(screen.getAllByRole('region', { name: 'Workspace pane' })).toHaveLength(1)
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  }
)

it.each<ExecutionHostId>(['local', 'ssh:build', 'runtime:mirror'])(
  'keeps a true folder workspace and project group on %s through duplicate, close and reopen',
  (host) => {
    const state = useAppStore.getState()
    const worktreeId = folderWorkspaceKey('folder')
    const connectionId = host === 'local' ? undefined : 'build'
    useAppStore.setState({
      projectGroups: [
        { id: 'group', name: 'Folder project', executionHostId: host, connectionId } as never
      ],
      folderWorkspaces: [
        {
          id: 'folder',
          projectGroupId: 'group',
          name: 'Folder workspace',
          folderPath: '/folder',
          executionHostId: host,
          connectionId
        } as never
      ],
      sshTargetLabels: new Map([['build', 'Build SSH']]),
      sshConnectionStates: new Map([['build', { status: 'connected' } as never]]),
      runtimeStatusByEnvironmentId: new Map([
        ['mirror', { status: { runtimeId: 'mirror' }, checkedAt: 1 } as never]
      ]),
      activeWorktreeId: worktreeId,
      activeWorkspaceExecutionHostId: host
    })
    state.createUnifiedTab(worktreeId, 'terminal', {
      executionHostId: host,
      entityId: 'folder-shell',
      label: 'Folder shell'
    })
    render(<Panes />)
    const label =
      host === 'local'
        ? /Folder project.*Folder workspace.*Folder shell.*This computer/
        : /Folder project.*Folder workspace.*Folder shell.*SSH.*Build SSH/
    expect(screen.getByLabelText(label, { selector: '[data-pane-context]' })).toBeTruthy()
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Window actions' }), { button: 0 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open Another View' }))
    const panes = screen.getAllByRole('region', { name: 'Workspace pane' })
    expect(panes).toHaveLength(2)
    expect(screen.getByText('Watching')).toBeTruthy()
    expect(within(panes[1]).getByText('Active pane')).toBeTruthy()
    expect(screen.queryByText('Connection unverifiable')).toBeNull()
    if (connectionId) {
      act(() =>
        useAppStore.setState(
          host === 'runtime:mirror'
            ? { runtimeStatusByEnvironmentId: new Map() }
            : { sshConnectionStates: new Map() }
        )
      )
      expect(screen.getAllByText('Connection unverifiable')).toHaveLength(2)
      expect(screen.queryByText('This computer')).toBeNull()
    }
    fireEvent.click(within(panes[1]).getByRole('button', { name: 'Close Pane' }))
    expect(screen.getAllByRole('region', { name: 'Workspace pane' })).toHaveLength(1)
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Window actions' }), { button: 0 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reopen Closed View' }))
    expect(screen.getAllByRole('region', { name: 'Workspace pane' })).toHaveLength(2)
    expect(useAppStore.getState().activeWorkspaceKey).toBe(worktreeId)
    expect(window.api.pty.spawn).not.toHaveBeenCalled()
    expect(window.api.pty.kill).not.toHaveBeenCalled()
  }
)
