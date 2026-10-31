import { beforeEach, expect, it, vi } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { ThreadProject } from './thread-projects'

const mocks = vi.hoisted(() => ({
  launch: vi.fn(() => ({ tab: null, settlement: Promise.resolve({ kind: 'structured' }) })),
  adopt: vi.fn((verdict: unknown) => verdict),
  projects: vi.fn(async (): Promise<ThreadProject[]> => []),
  openModal: vi.fn(),
  setActiveView: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { experimentalThreads: true, defaultTuiAgent: 'codex' },
      openModal: mocks.openModal,
      setActiveView: mocks.setActiveView
    })
  }
}))
vi.mock('@/lib/agent-session-launch-plan', () => ({ adoptAgentSessionLaunchVerdict: mocks.adopt }))
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.launch
}))
vi.mock('./thread-projects', () => ({ eligibleThreadProjects: mocks.projects }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree: vi.fn() }))
vi.mock('@/runtime/layout-owner-pending-tabs', () => ({ afterPendingTab: vi.fn() }))
import { openNewThread, sendNewThread } from './thread-actions'
import { useThreadNavigation } from './thread-navigation'

const project: ThreadProject = {
  key: 'local|repo',
  hostId: 'local',
  repo: { id: 'repo', path: '/main', displayName: 'Project', badgeColor: '', addedAt: 1 },
  worktree: makeWorktree({ id: 'repo::/main', repoId: 'repo', path: '/main', isMainWorktree: true })
}
beforeEach(() => {
  vi.clearAllMocks()
  useThreadNavigation.setState({ selection: null })
})
it('creates nothing on opening a new thread; send uses the project main checkout and the default agent', async () => {
  mocks.projects.mockResolvedValue([project])
  await openNewThread()
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(useThreadNavigation.getState().selection).toMatchObject({
    kind: 'new',
    projectKey: project.key
  })
  sendNewThread(project, 'Fix the tests')
  expect(mocks.adopt).toHaveBeenCalledWith(
    expect.objectContaining({
      surface: 'thread',
      requestedSurface: 'chat',
      worktreeId: 'repo::/main',
      executionHostId: 'local',
      agent: 'codex',
      prompt: 'Fix the tests',
      promptDelivery: 'auto-submit'
    })
  )
  expect(mocks.launch).toHaveBeenCalledWith(
    expect.objectContaining({ target: { worktreeId: 'repo::/main', executionHostId: 'local' } })
  )
})
it('opens Add project when no host supports thread creation', async () => {
  mocks.projects.mockResolvedValue([])
  await openNewThread()
  expect(mocks.openModal).toHaveBeenCalledWith('add-repo')
  expect(mocks.launch).not.toHaveBeenCalled()
  expect(useThreadNavigation.getState().selection).toBeNull()
})
