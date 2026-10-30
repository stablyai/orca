// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Toaster, toast } from 'sonner'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../shared/constants'
import { makeFolderWorkspace, makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { launchAgentSessionContinuation } from './launch-agent-session-continuation'
import type { LaunchAgentInNewTabArgs } from './launch-agent-in-new-tab-args'
import type { LaunchAgentInNewTabResult } from './launch-agent-in-new-tab-host-agents'

const mocks = vi.hoisted(() => ({
  launch: vi.fn<(args: LaunchAgentInNewTabArgs) => LaunchAgentInNewTabResult>()
}))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: mocks.launch }))
vi.mock('@/runtime/structured-agent-session-tab-retirement', () => ({
  beginStructuredAgentSessionTabClose: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('./host-chat-program-acquisition', () => ({
  acquireAgentLaunchChoices: async () => ({ detected: ['codex'], offered: ['codex'] })
}))

const initial = useAppStore.getState()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  mocks.launch.mockReset()
  mocks.launch.mockImplementation(({ worktreeId, agentSessionLaunchPlan }) => {
    useAppStore.getState().createUnifiedTab(worktreeId, 'agent-session', {
      id: 'agent-session:continuation',
      entityId: 'continuation',
      executionHostId: agentSessionLaunchPlan?.executionHostId,
      agentSessionAgent: 'codex',
      activate: false
    })
    return { surface: { kind: 'host-published' }, pasteDraftAfterLaunch: false }
  })
  useAppStore.setState({
    settings: getDefaultSettings('/test'),
    repos: [{ id: 'repo-1', path: '/repo', displayName: 'Repo', badgeColor: '', addedAt: 0 }],
    worktreesByRepo: {
      'repo-1': [
        makeWorktree({ id: 'source', repoId: 'repo-1', path: '/repo/source', hostId: 'local' }),
        makeWorktree({
          id: 'target',
          repoId: 'repo-1',
          path: '/repo/target',
          displayName: 'Destination worktree',
          hostId: 'local'
        })
      ]
    },
    folderWorkspaces: [
      makeFolderWorkspace({
        id: 'local-folder',
        name: 'Local folder',
        executionHostId: 'local'
      }),
      makeFolderWorkspace({
        id: 'remote-folder',
        name: 'Remote folder',
        executionHostId: 'runtime:paired'
      })
    ],
    activeRepoId: 'repo-1',
    activeWorktreeId: 'source',
    activeWorkspaceExecutionHostId: 'local',
    activeView: 'terminal',
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
})
afterEach(() => {
  cleanup()
  toast.dismiss()
  vi.clearAllTimers()
  vi.useRealTimers()
  useAppStore.setState(initial, true)
})

it.each([
  { worktreeId: 'target', executionHostId: 'local', name: 'Destination worktree' },
  { worktreeId: 'folder:local-folder', executionHostId: 'local', name: 'Local folder' },
  {
    worktreeId: 'folder:remote-folder',
    executionHostId: 'runtime:paired',
    name: 'Remote folder'
  }
] as const)(
  'names $name and opens its host only when the toast action is clicked',
  async ({ worktreeId, executionHostId, name }) => {
    render(<Toaster closeButton />)
    await act(async () => {
      await expect(
        launchAgentSessionContinuation({
          agent: 'codex',
          prompt: 'Continue the saved task',
          worktreeId,
          launchSource: 'sidebar',
          launchChoice: { agent: 'codex', route: 'structured-native-chat', executionHostId }
        })
      ).resolves.toBe(true)
    })
    expect(screen.queryByText(name)).toBeNull()
    expect(useAppStore.getState().activeWorktreeId).toBe('source')

    await act(async () => {
      mocks.launch.mock.calls[0]?.[0].onPromptDelivered?.()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(screen.getByText(name)).toBeTruthy()
    expect(useAppStore.getState().activeWorktreeId).toBe('source')
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')

    fireEvent.click(screen.getByRole('button', { name: 'Go to workspace' }))

    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId)
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe(executionHostId)
    expect(useAppStore.getState().unifiedTabsByWorktree[worktreeId]).toEqual([
      expect.objectContaining({ id: 'agent-session:continuation', executionHostId })
    ])
    expect(useAppStore.getState().tabsByWorktree[worktreeId] ?? []).toEqual([])
  }
)

it.each(['target', 'folder:local-folder'])(
  'recovers an empty %s when the continuation closes before clicking the toast',
  async (worktreeId) => {
    render(<Toaster closeButton />)
    await act(async () => {
      await launchAgentSessionContinuation({
        agent: 'codex',
        prompt: 'Continue the saved task',
        worktreeId,
        launchSource: 'sidebar',
        launchChoice: {
          agent: 'codex',
          route: 'structured-native-chat',
          executionHostId: 'local'
        }
      })
      mocks.launch.mock.calls[0]?.[0].onPromptDelivered?.()
      await vi.advanceTimersByTimeAsync(0)
    })

    useAppStore.getState().closeUnifiedTab('agent-session:continuation')
    expect(useAppStore.getState().reconcileWorktreeTabModel(worktreeId).renderableTabCount).toBe(0)
    expect(useAppStore.getState().activeWorktreeId).toBe('source')

    fireEvent.click(screen.getByRole('button', { name: 'Go to workspace' }))

    expect(useAppStore.getState().activeWorktreeId).toBe(worktreeId)
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')
    expect(useAppStore.getState().tabsByWorktree[worktreeId]).toHaveLength(1)
  }
)
