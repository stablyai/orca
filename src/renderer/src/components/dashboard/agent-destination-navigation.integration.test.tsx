import type * as RuntimeRpcCallModule from '@/runtime/rpc/calls/runtime-rpc-call'
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import {
  makeCreatedAgentWorktree,
  seedAlreadyActiveWorktree
} from '@/lib/workspace/activation/worktree-activation-created-agent.test-fixture'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'

import type * as WebRuntimeSessionEnvironment from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { AgentKanbanBoard } from '../dashboard-popout/AgentKanbanBoard'
import WorktreeCardAgents from '../sidebar/workspace-card/activity/WorktreeCardAgents'
import { TooltipProvider } from '@/components/ui/tooltip'
import { buildDashboardSnapshot } from './build-dashboard-snapshot'
import { revealDashboardAgent } from './reveal-dashboard-agent'
import { activateWorktreeAgentPane } from '../sidebar/workspace-card/activity/use-worktree-agent-activation'
import { structuredAgentSessionPaneKey } from '../../../../shared/agent-session/view/structured-agent-session-projection'

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
vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({ AgentTerminalPreview: () => null }))
vi.mock(
  '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment',
  async (importOriginal) => ({
    ...(await importOriginal<typeof WebRuntimeSessionEnvironment>()),
    captureRuntimeEnvironmentCall: (environmentId: string) => (args: unknown) =>
      effects.environmentCall(environmentId, args)
  })
)

const initialState = useAppStore.getState()
const LEAF = '11111111-1111-4111-8111-111111111111'
const WORKSPACE_HOST = 'runtime:host-A' as const
const TAB_HOST = 'runtime:host-B' as const
const NOW = 1_000_000_000

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('Dashboard and sidebar destination contract', () => {
  it.each([
    ['worktree', 'native'],
    ['folder', 'native'],
    ['worktree', 'terminal'],
    ['folder', 'terminal']
  ] as const)(
    'opens the exact %s %s destination and preserves reveal failure',
    async (scope, surface) => {
      const native = surface === 'native'
      const owner = native ? TAB_HOST : WORKSPACE_HOST
      const worktree = {
        ...makeCreatedAgentWorktree(),
        hostId: WORKSPACE_HOST,
        ...(scope === 'folder' ? { id: folderWorkspaceKey('folder-1') } : {})
      }
      seedAlreadyActiveWorktree(worktree)
      const seeded = useAppStore.getState()
      const terminal = { ...seeded.tabsByWorktree[worktree.id][0], executionHostId: owner }
      const tabId = native ? 'native-B' : terminal.id
      const paneKey = makePaneKey(tabId, LEAF)
      const group = seeded.groupsByWorktree[worktree.id][0]
      const nativeTab: Tab = {
        id: tabId,
        worktreeId: worktree.id,
        executionHostId: TAB_HOST,
        contentType: 'agent-session',
        entityId: 'session-B',
        groupId: group.id,
        label: 'Codex',
        customLabel: null,
        color: null,
        sortOrder: 1,
        createdAt: NOW
      }
      const folder = {
        id: 'folder-1',
        projectGroupId: 'project-1',
        name: 'Notes',
        folderPath: '/workspace/notes',
        executionHostId: WORKSPACE_HOST,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: NOW,
        createdAt: NOW,
        updatedAt: NOW
      }
      useAppStore.setState({
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        activeTabType: 'editor',
        agentActivityDisplayMode: 'compact',
        repos: scope === 'folder' ? [] : seeded.repos,
        worktreesByRepo:
          scope === 'folder'
            ? {}
            : {
                [worktree.repoId]: [
                  worktree,
                  ...(native ? [{ ...worktree, hostId: TAB_HOST }] : [])
                ]
              },
        folderWorkspaces:
          scope === 'folder'
            ? [folder, ...(native ? [{ ...folder, executionHostId: TAB_HOST }] : [])]
            : [],
        getFreshFolderWorkspacePathStatus: () => ({ path: folder.folderPath, exists: true }),
        tabsByWorktree: { [worktree.id]: [terminal] },
        unifiedTabsByWorktree: {
          [worktree.id]: [
            ...seeded.unifiedTabsByWorktree[worktree.id],
            ...(native ? [nativeTab] : [])
          ]
        },
        groupsByWorktree: {
          [worktree.id]: [{ ...group, tabOrder: [...group.tabOrder, ...(native ? [tabId] : [])] }]
        },
        terminalLayoutsByTabId: native
          ? {}
          : {
              [tabId]: {
                root: { type: 'leaf', leafId: LEAF },
                activeLeafId: LEAF,
                expandedLeafId: null
              }
            },
        agentStatusByPaneKey: {
          [paneKey]: {
            paneKey,
            tabId,
            worktreeId: worktree.id,
            state: 'done',
            agentType: 'codex',
            prompt: 'Open this conversation',
            updatedAt: NOW,
            stateStartedAt: NOW,
            stateHistory: []
          }
        }
      })

      const snapshot = buildDashboardSnapshot(
        { ...useAppStore.getState(), chatNames: new Map() },
        NOW
      )
      const card = snapshot.cards.find((candidate) => candidate.executionHostId === WORKSPACE_HOST)
      expect(card).toMatchObject({ worktreeId: worktree.id, tabId })
      if (!card) {
        throw new Error('Expected a card from the production snapshot builder')
      }
      // Give the virtual lane a viewport; happy-dom has no layout.
      vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600)
      const view = render(
        <TooltipProvider>
          <AgentKanbanBoard
            snapshot={{ ...snapshot, cards: [card] }}
            onAckAgent={() => {}}
            onRevealAgent={revealDashboardAgent}
          />
        </TooltipProvider>
      )
      fireEvent.click(screen.getByRole('button', { name: /Open this conversation/ }))
      fireEvent.click(screen.getByRole('button', { name: 'Open worktree' }))

      const assertDestination = async (): Promise<void> => {
        const state = useAppStore.getState()
        expect(state.activeWorktreeId).toBe(worktree.id)
        expect(getExecutionHostIdForWorktree(state, worktree.id)).toBe(owner)
        expect(state.activeTabType).toBe(native ? 'agent-session' : 'terminal')
        if (!native) {
          expect(state.activeTabId).toBe(tabId)
        }
        expect(state.getActiveTab(worktree.id)?.id).toBe(tabId)
        expect(state.groupsByWorktree[worktree.id][0].activeTabId).toBe(tabId)
        if (native) {
          expect(effects.composerFocus).toHaveBeenLastCalledWith(tabId)
          expect(effects.rpc).toHaveBeenCalledWith(
            { kind: 'environment', environmentId: 'host-B' },
            'session.tabs.activate',
            expect.objectContaining({ tabId: 'agent-session:session-B' })
          )
        } else {
          await vi.waitFor(() =>
            expect(effects.environmentCall).toHaveBeenCalledWith(
              'host-A',
              expect.objectContaining({
                method: 'session.tabs.activate',
                params: expect.objectContaining({ leafId: LEAF })
              })
            )
          )
        }
      }
      await assertDestination()
      view.unmount()

      if (!native) {
        useAppStore.setState({
          activeWorktreeId: null,
          activeWorkspaceExecutionHostId: null,
          activeTabType: 'editor',
          activeTabId: null
        })
        const sidebar = render(
          <TooltipProvider>
            <WorktreeCardAgents worktreeId={worktree.id} />
          </TooltipProvider>
        )
        const row = sidebar.container.querySelector('.compact-agent-row')
        if (!row) {
          throw new Error('Expected the live sidebar row')
        }
        effects.environmentCall.mockClear()
        fireEvent.click(row)
        await assertDestination()
      }

      // Keep the exact tab alive while its workspace disappears: neither entry may focus or notify it.
      cleanup()
      useAppStore.setState({
        worktreesByRepo: {},
        folderWorkspaces: [],
        activeWorktreeId: null,
        activeWorkspaceExecutionHostId: null,
        activeTabType: 'editor',
        activeTabId: null
      })
      effects.rpc.mockClear()
      effects.composerFocus.mockClear()
      effects.environmentCall.mockClear()
      expect(revealDashboardAgent(card)).toBe(false)
      if (!native) {
        const missing = render(
          <TooltipProvider>
            <WorktreeCardAgents worktreeId={worktree.id} />
          </TooltipProvider>
        )
        const missingRow = missing.container.querySelector('.compact-agent-row')
        if (!missingRow) {
          throw new Error('Expected the attributed row after workspace removal')
        }
        fireEvent.click(missingRow)
      }
      expect(useAppStore.getState()).toMatchObject({
        activeWorktreeId: null,
        activeTabId: null,
        activeTabType: 'editor'
      })
      expect(effects.composerFocus).not.toHaveBeenCalled()
      expect(effects.rpc).not.toHaveBeenCalled()
      expect(effects.environmentCall).not.toHaveBeenCalled()
    }
  )
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

it('opens a live paired chat from its physical SSH workspace', () => {
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
  activateWorktreeAgentPane(
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
  expect(effects.composerFocus).toHaveBeenCalledWith('native-B')
  expect(effects.rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'host-B' },
    'session.tabs.activate',
    expect.objectContaining({ tabId: 'agent-session:session-B' })
  )
})
