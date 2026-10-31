// @vitest-environment happy-dom
import userEvent from '@testing-library/user-event'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  makeCreatedAgentWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent.test-fixture'
import { openStructuredAgentSessionProvisionalTab } from '@/lib/structured-agent-session-launch-surface'
import type * as AgentLaunchPlanModule from '@/lib/agent-session-launch-plan'
import type { ProvisionalLaunchArgs } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { SidebarConversationStart } from './SidebarConversationStart'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { AgentMenuRowsTarget } from '@/components/tab-bar/use-new-tab-agent-menu-rows'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/hooks/useAgentDetectionTarget', () => ({
  useAgentDetectionTargetForWorktree: () => ({ kind: 'local' })
}))
vi.mock('@/components/tab-bar/use-new-tab-agent-menu-rows', () => ({
  useAgentMenuObservation: (target: string | AgentMenuRowsTarget | null) => ({
    model: {
      state: 'settled',
      rows: ['claude', 'codex', 'antigravity'].map((agent) => ({
        kind: 'chat',
        agent,
        executionHostId: typeof target === 'string' ? 'local' : target?.workspace.executionHostId
      }))
    }
  })
}))
vi.mock('@/lib/agent-session-launch-plan', async (importOriginal) => {
  const original = await importOriginal<typeof AgentLaunchPlanModule>()
  return {
    ...original,
    planAgentSessionLaunch: (...args: Parameters<typeof original.planAgentSessionLaunch>) => {
      const request = args[1]
      return original.adoptAgentSessionLaunchVerdict({
        route: 'structured-native-chat',
        requestId: request.requestId,
        agent: request.agent,
        worktreeId: request.workspace.worktreeId,
        executionHostId: request.selectedExecutionHostId ?? 'local'
      })
    }
  }
})
// Provider admission is outside this UI test; retain the real launcher, layout and selection.
vi.mock('@/lib/agent-session/structured-agent-session-provisional-tab', async (importOriginal) => ({
  ...(await importOriginal()),
  beginStructuredAgentSessionProvisionalLaunch: (args: ProvisionalLaunchArgs) => {
    const worktreeId = args.target?.worktreeId ?? args.plan.worktreeId
    if (!worktreeId) {
      throw new Error('Missing target workspace')
    }
    const tab = openStructuredAgentSessionProvisionalTab({
      worktreeId,
      executionHostId: args.plan.executionHostId ?? 'local',
      agent: args.plan.agent,
      sessionId: `new-${args.plan.agent}`
    })
    return { tab, settlement: Promise.resolve({ kind: 'structured', sessionId: tab.entityId }) }
  }
}))

const initial = useAppStore.getState()
const workspace = makeCreatedAgentWorktree()

beforeEach(() => {
  seedEmptyActivatableWorktree(workspace)
  useAppStore.setState({
    activeRepoId: 'another-project',
    activeWorktreeId: 'another-workspace',
    activeWorkspaceExecutionHostId: 'local',
    sidebarBody: 'conversations'
  })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})

describe.each(['worktree', 'folder'] as const)('new chat from a %s project sidebar', (kind) => {
  it.each(['Claude', 'Codex', 'Antigravity'])(
    'reveals an inactive empty project and selects its new %s chat without a shell',
    async (label) => {
      const folder: FolderWorkspace = {
        id: 'empty-folder',
        projectGroupId: 'folder-project',
        name: 'Empty folder',
        folderPath: '/workspace/folder',
        executionHostId: 'local',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
      const workspaceId = kind === 'folder' ? folderWorkspaceKey(folder.id) : workspace.id
      if (kind === 'folder') {
        useAppStore.setState({
          folderWorkspaces: [folder],
          projectGroups: [
            {
              id: folder.projectGroupId,
              name: 'Folder project',
              parentPath: '/workspace',
              connectionId: null,
              parentGroupId: null,
              createdFrom: 'manual',
              tabOrder: 0,
              isCollapsed: false,
              color: null,
              createdAt: 0,
              updatedAt: 0
            }
          ]
        })
      }
      expect(useAppStore.getState().reconcileWorktreeTabModel(workspaceId).renderableTabCount).toBe(
        0
      )
      const user = userEvent.setup()
      render(
        <TooltipProvider>
          <SidebarConversationStart
            worktreeId={workspaceId}
            executionHostId="local"
            projectName="Empty project"
          />
        </TooltipProvider>
      )
      await user.click(screen.getByRole('button', { name: 'New chat in Empty project' }))
      await user.click(screen.getByRole('menuitem', { name: label }))
      await waitFor(() => {
        const state = useAppStore.getState()
        expect(state.unifiedTabsByWorktree[workspaceId]).toHaveLength(1)
        expect(state.getActiveTab(workspaceId)?.contentType).toBe('agent-session')
        expect(state.activeWorktreeId).toBe(workspaceId)
        if (kind === 'worktree') {
          expect(state.activeRepoId).toBe(workspace.repoId)
        }
        expect(state.activeView).toBe('terminal')
        expect(state.sidebarBody).toBe('conversations')
        expect(state.tabsByWorktree[workspaceId] ?? []).toHaveLength(0)
      })
    }
  )
})

describe.each(['worktree', 'folder'] as const)('same-ID %s project owners', (kind) => {
  it.each(['local', 'runtime:paired'] as const)(
    'keeps the %s new-chat button and opens a chat on that host while a twin is selected',
    async (host) => {
      const hosts: ExecutionHostId[] = ['local', 'runtime:paired']
      const workspaceId = kind === 'folder' ? folderWorkspaceKey('twins') : workspace.id
      const repo = useAppStore.getState().repos[0]
      useAppStore.setState({
        repos: hosts.map((executionHostId) => ({ ...repo, executionHostId })),
        runtimeStatusByEnvironmentId: new Map([
          [
            'paired',
            {
              checkedAt: 1,
              status: {
                runtimeId: 'paired-runtime',
                rendererGraphEpoch: 0,
                graphStatus: 'ready',
                authoritativeWindowId: null,
                liveTabCount: 0,
                liveLeafCount: 0,
                hostPlatform: 'linux'
              }
            }
          ]
        ]),
        worktreesByRepo: {
          [workspace.repoId]: hosts.map((hostId) => ({ ...workspace, hostId }))
        },
        folderWorkspaces: hosts.map((executionHostId) => ({
          id: 'twins',
          projectGroupId: 'group',
          name: 'Twin',
          folderPath: '/workspace/folder',
          executionHostId,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          createdAt: 0,
          updatedAt: 0
        }))
      })
      const user = userEvent.setup()
      render(
        <TooltipProvider>
          <SidebarConversationStart
            worktreeId={workspaceId}
            executionHostId={host}
            projectName="Twin"
          />
        </TooltipProvider>
      )
      const button = screen.getByRole('button', { name: 'New chat in Twin' })
      act(() =>
        useAppStore.setState({
          activeWorktreeId: workspaceId,
          activeWorkspaceExecutionHostId: host === 'local' ? 'runtime:paired' : 'local'
        })
      )
      await user.click(button)
      await user.click(screen.getByRole('menuitem', { name: 'Codex' }))
      await waitFor(() => {
        const state = useAppStore.getState()
        expect(state.activeWorkspaceExecutionHostId).toBe(host)
        expect(state.getActiveTab(workspaceId)?.executionHostId).toBe(host)
        expect(state.getActiveTab(workspaceId)?.contentType).toBe('agent-session')
        expect(state.tabsByWorktree[workspaceId] ?? []).toHaveLength(0)
      })
    }
  )
})
