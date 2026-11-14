import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
// @vitest-environment happy-dom

// @vitest-environment happy-dom
import { cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'

import {
  makeCreatedAgentWorktree,
  seedAlreadyActiveWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

import type * as WebRuntimeSessionEnvironment from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'

import { activateRetainedAgentRow } from '../../sidebar/workspace-card/activity/activate-retained-agent-row'
import { activateWorktreeAgentPane } from '../../sidebar/workspace-card/activity/use-worktree-agent-activation'
import { structuredAgentSessionPaneKey } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

const effects = vi.hoisted(() => ({
  rpc: vi.fn(async () => ({ ok: true })),
  composerFocus: vi.fn(),
  environmentCall: vi.fn(async (_environmentId: string, _args: unknown) => ({
    id: 'navigation-test',
    ok: false as const,
    error: { code: 'unavailable', message: 'Unit-test transport boundary' }
  }))
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: effects.rpc
}))
vi.mock('@/components/native-chat/composer/focus/native-chat-composer-focus-intent', () => ({
  requestNativeChatComposerFocus: effects.composerFocus
}))
vi.mock('../terminal-preview/AgentTerminalPreview', () => ({ AgentTerminalPreview: () => null }))
vi.mock(
  '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WebRuntimeSessionEnvironment>()),
    captureRuntimeEnvironmentCall: (environmentId: string) => (args: unknown) =>
      effects.environmentCall(environmentId, args)
  })
)

const initialState = useAppStore.getState()
const NOW = 1_000_000_000
const LEAF = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_HOST = 'runtime:host-A' as const
const TAB_HOST = 'runtime:host-B' as const

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('Dashboard and retained sidebar destination contract', () => {
  it('notifies the exact live retained terminal owner instead of the workspace default', async () => {
    const worktree = { ...makeCreatedAgentWorktree(), hostId: WORKSPACE_HOST }
    seedAlreadyActiveWorktree(worktree, {
      worktreesByRepo: { [worktree.repoId]: [worktree, { ...worktree, hostId: TAB_HOST }] },
      activeWorkspaceExecutionHostId: WORKSPACE_HOST,
      ptyIdsByTabId: { 'tab-1': ['remote:host-B@@pty-B'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'remote:host-B@@pty-B' }
        }
      }
    })

    activateRetainedAgentRow(worktree.id, 'tab-1', makePaneKey('tab-1', LEAF))
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe(TAB_HOST)
    await vi.waitFor(() =>
      expect(effects.environmentCall).toHaveBeenCalledWith(
        'host-B',
        expect.objectContaining({
          method: 'session.tabs.activate',
          params: expect.objectContaining({ leafId: LEAF })
        })
      )
    )
    expect(useAppStore.getState().getActiveTab(worktree.id)?.id).toBe('tab-1')
  })
})

it('rejects a live terminal row on a different host before workspace activation', () => {
  const worktree = { ...makeCreatedAgentWorktree(), hostId: WORKSPACE_HOST }
  seedAlreadyActiveWorktree(worktree, {
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    activeTabId: null,
    ptyIdsByTabId: { 'tab-1': ['remote:host-B@@pty-B'] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'remote:host-B@@pty-B' }
      }
    }
  })

  activateWorktreeAgentPane(worktree.id, 'tab-1', makePaneKey('tab-1', LEAF), WORKSPACE_HOST)

  expect(useAppStore.getState()).toMatchObject({
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    activeTabId: null
  })
})

it('opens a paired chat from its physical SSH workspace', () => {
  const worktree = {
    ...makeCreatedAgentWorktree(),
    hostId: 'ssh:server' as const,
    runtimeOwnerEnvironmentId: 'host-B'
  }
  seedAlreadyActiveWorktree(worktree, {
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null,
    activeTabType: 'editor',
    unifiedTabsByWorktree: {
      [worktree.id]: [
        {
          id: 'native-B',
          worktreeId: worktree.id,
          executionHostId: TAB_HOST,
          contentType: 'agent-session',
          agentSessionAgent: 'claude',
          entityId: 'session-B',
          groupId: 'group-1',
          label: 'Codex',
          customLabel: null,
          color: null,
          sortOrder: 1,
          createdAt: NOW
        }
      ]
    }
  })
  activateRetainedAgentRow(
    worktree.id,
    'native-B',
    structuredAgentSessionPaneKey('native-B', 'session-B'),
    'ssh:server'
  )

  expect(useAppStore.getState()).toMatchObject({
    activeWorktreeId: worktree.id,
    activeWorkspaceExecutionHostId: 'ssh:server',
    activeTabType: 'agent-session'
  })
})
