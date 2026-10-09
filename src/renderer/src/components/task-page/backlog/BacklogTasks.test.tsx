// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BacklogTasks } from './BacklogTasks'
import { callBacklog } from '@/lib/backlog-task-source'
import type * as BacklogSource from '@/lib/backlog-task-source'
import type { Repo } from '../../../../../shared/repo-types'
import type { RuntimeEnvironmentStatus } from '../../../../../shared/runtime-host-status'
import { BACKLOG_TASKS_CAPABILITY } from '../../../../../shared/backlog-capability'

const mocks = vi.hoisted(
  (): {
    openModal: ReturnType<typeof vi.fn>
    repos: Repo[]
    runtimeStatusByEnvironmentId: Map<string, RuntimeEnvironmentStatus>
  } => ({
    openModal: vi.fn(),
    runtimeStatusByEnvironmentId: new Map<string, RuntimeEnvironmentStatus>(),
    repos: [
      {
        id: 'folder',
        path: '/folder',
        kind: 'folder',
        displayName: 'Folder project',
        addedAt: 0,
        badgeColor: ''
      }
    ] satisfies Repo[]
  })
)
vi.mock('@/store', () => ({
  useAppStore: Object.assign((select: (state: unknown) => unknown) => select(mocks), {
    getState: () => mocks
  })
}))
vi.mock('@/lib/backlog-task-source', async (original) => ({
  ...(await original<typeof BacklogSource>()),
  callBacklog: vi.fn()
}))
vi.mock('../../task-page-source-context', () => ({
  getTaskPageRepoSourceContext: () => ({
    kind: 'task-source',
    provider: 'backlog',
    projectId: 'folder',
    repoId: 'folder',
    hostId: 'local'
  })
}))

const list = {
  projectPath: '/folder',
  projectName: 'Folder project',
  statuses: ['Inbox', 'Review'],
  tasks: [{ id: 'OPS-007', title: 'Task title', status: 'Review' }],
  total: 1,
  mutationUnavailable: null
}
beforeEach(() => {
  vi.resetAllMocks()
  mocks.repos = [
    {
      id: 'folder',
      path: '/folder',
      kind: 'folder',
      displayName: 'Folder project',
      addedAt: 0,
      badgeColor: ''
    }
  ]
  mocks.runtimeStatusByEnvironmentId = new Map()
  vi.mocked(callBacklog).mockResolvedValue(list)
})
afterEach(cleanup)

describe('Backlog Tasks UI', () => {
  it('browses details and seeds the existing workspace composer without launching an agent', async () => {
    render(<BacklogTasks />)
    const row = await screen.findByRole('button', { name: /OPS-007/ })
    vi.mocked(callBacklog).mockResolvedValueOnce({
      id: 'OPS-007',
      title: 'Task title',
      status: 'Review',
      description: 'Description',
      body: 'Acceptance criteria'
    })
    fireEvent.click(row)
    expect(await screen.findByText('Acceptance criteria')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start workspace' }))
    expect(mocks.openModal).toHaveBeenCalledWith(
      'new-workspace-composer',
      expect.objectContaining({
        initialRepoId: 'folder',
        taskSourceContext: expect.objectContaining({ provider: 'backlog', hostId: 'local' }),
        backlogTaskPrompt: expect.stringContaining('OPS-007')
      })
    )
  })
  it.each(['Legacy', 'Review'])(
    'edits a legacy task with an explicit status choice of %s',
    async (status) => {
      render(<BacklogTasks />)
      const row = await screen.findByRole('button', { name: /OPS-007/ })
      vi.mocked(callBacklog).mockResolvedValueOnce({
        id: 'OPS-007',
        title: 'Task title',
        status: 'Legacy',
        description: 'Description',
        body: 'Details'
      })
      fireEvent.click(row)
      await screen.findByText('Details')
      fireEvent.click(screen.getByRole('button', { name: 'Edit task' }))
      expect(screen.getByRole('combobox', { name: 'Task status' })).toHaveTextContent(
        'Legacy (not configured)'
      )
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New title' } })
      if (status === 'Review') {
        fireEvent.click(screen.getByRole('combobox', { name: 'Task status' }))
        fireEvent.click(await screen.findByRole('option', { name: 'Review' }))
      }
      expect(screen.getByRole('button', { name: 'Save task' })).toBeEnabled()
      vi.mocked(callBacklog).mockResolvedValueOnce({ saved: true })
      fireEvent.click(screen.getByRole('button', { name: 'Save task' }))
      await waitFor(() =>
        expect(callBacklog).toHaveBeenCalledWith(expect.anything(), {
          kind: 'edit',
          id: 'OPS-007',
          title: 'New title',
          description: 'Description',
          status
        })
      )
    }
  )
  it('selects the first supported project and excludes unsupported runtime projects', async () => {
    const local = mocks.repos[0]
    mocks.repos = [
      { ...local, id: 'old', displayName: 'Old host', executionHostId: 'runtime:old' },
      local
    ]
    render(<BacklogTasks />)
    await screen.findByRole('button', { name: /OPS-007/ })
    expect(callBacklog).toHaveBeenCalledWith(local, expect.objectContaining({ kind: 'list' }))
    expect(screen.getByRole('combobox', { name: 'Backlog project' })).toHaveTextContent(
      'Folder project'
    )
    fireEvent.click(screen.getByRole('combobox', { name: 'Backlog project' }))
    expect(screen.queryByRole('option', { name: /Old host/ })).toBeNull()
  })
  it('withdraws tasks when runtime capability is lost and guards a stale start handler', async () => {
    mocks.repos = [{ ...mocks.repos[0], executionHostId: 'runtime:remote' }]
    mocks.runtimeStatusByEnvironmentId.set('remote', {
      checkedAt: 0,
      status: {
        runtimeId: 'remote',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: 1,
        minCompatibleRuntimeClientVersion: 1,
        capabilities: [BACKLOG_TASKS_CAPABILITY]
      }
    })
    const view = render(<BacklogTasks />)
    const row = await screen.findByRole('button', { name: /OPS-007/ })
    vi.mocked(callBacklog).mockResolvedValueOnce({
      id: 'OPS-007',
      title: 'Task title',
      status: 'Review',
      description: '',
      body: 'Details'
    })
    fireEvent.click(row)
    await screen.findByText('Details')
    mocks.runtimeStatusByEnvironmentId = new Map()
    fireEvent.click(screen.getByRole('button', { name: 'Start workspace' }))
    expect(mocks.openModal).not.toHaveBeenCalled()
    view.rerender(<BacklogTasks />)
    expect(screen.queryByRole('button', { name: 'Start workspace' })).toBeNull()
    expect(screen.getByText(/Update the project’s Orca server/)).toBeInTheDocument()
  })
  it('shows an actionable empty-project state without calling a host', () => {
    mocks.repos = []
    render(<BacklogTasks />)
    expect(
      screen.getByText('Add a project or folder to browse Backlog.md tasks.')
    ).toBeInTheDocument()
    expect(callBacklog).not.toHaveBeenCalled()
  })
  it('creates tasks only through the host call and refreshes after saving', async () => {
    render(<BacklogTasks />)
    await screen.findByRole('button', { name: /OPS-007/ })
    fireEvent.click(screen.getByRole('button', { name: 'New task' }))
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '--literal title' } })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Multi\nline' } })
    vi.mocked(callBacklog).mockResolvedValueOnce({ saved: true })
    fireEvent.click(screen.getByRole('button', { name: 'Save task' }))
    await waitFor(() =>
      expect(callBacklog).toHaveBeenCalledWith(expect.objectContaining({ kind: 'folder' }), {
        kind: 'create',
        title: '--literal title',
        description: 'Multi\nline',
        status: 'Inbox'
      })
    )
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it.each(['RPC timeout', 'SSH disconnected'])(
    'prevents resubmission after an ambiguous create: %s',
    async (message) => {
      render(<BacklogTasks />)
      await screen.findByRole('button', { name: /OPS-007/ })
      fireEvent.click(screen.getByRole('button', { name: 'New task' }))
      fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Possibly created' } })
      vi.mocked(callBacklog).mockRejectedValueOnce(new Error(message))
      fireEvent.click(screen.getByRole('button', { name: 'Save task' }))
      expect(await screen.findByRole('alert')).toHaveTextContent(message)
      expect(screen.getByRole('button', { name: 'Save task' })).toBeDisabled()
      fireEvent.submit(screen.getByRole('button', { name: 'Save task' }).closest('form')!)
      expect(
        vi.mocked(callBacklog).mock.calls.filter(([, operation]) => operation.kind === 'create')
      ).toHaveLength(1)
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
      expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
      fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
      await waitFor(() => expect(screen.getByRole('button', { name: 'New task' })).toBeEnabled())
    }
  )
  it('shows actionable host errors and no false empty-state success', async () => {
    vi.mocked(callBacklog).mockRejectedValue(new Error('Reconnect SSH host'))
    render(<BacklogTasks />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Reconnect SSH host')
    expect(screen.queryByText('No matching tasks.')).toBeNull()
    expect(screen.getByRole('button', { name: 'New task' })).toBeDisabled()
  })
})
