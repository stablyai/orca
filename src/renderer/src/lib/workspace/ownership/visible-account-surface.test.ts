import { withHeldTabsAsDrawn } from '@/store/workspace-layout/frames/workspace-layout-frame-held-tabs'
import type { LayoutFrameSlices } from '@/store/workspace-layout/frames/workspace-layout-frame-slices'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import {
  nativeChatSurfaceVisible,
  visibleAccountHostId,
  pendingChatAccountOwner
} from './visible-account-surface'
import type { VisibleAccountSurfaceState } from './visible-account-surface'
import type { PendingWorktreeCreation } from '../creation/pending-worktree-creation'

const REMOTE_WORKTREE = 'remote-repo::/srv/app'
const LOCAL_WORKTREE = 'local-repo::/Users/me/app'

function state(overrides: Partial<VisibleAccountSurfaceState> = {}): VisibleAccountSurfaceState {
  return {
    runtimeEnvironments: [{ id: 'm4' }],
    runtimeEnvironmentCatalogHydrated: true,
    repos: [
      {
        id: 'remote-repo',
        path: '/srv/app',
        connectionId: null,
        executionHostId: 'runtime:m4'
      },
      {
        id: 'local-repo',
        path: '/Users/me/app',
        connectionId: null,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: {
      'remote-repo': [{ id: REMOTE_WORKTREE, repoId: 'remote-repo', hostId: 'runtime:m4' }],
      'local-repo': [{ id: LOCAL_WORKTREE, repoId: 'local-repo', hostId: 'local' }]
    },
    activeWorktreeId: REMOTE_WORKTREE,
    activeWorkspaceExecutionHostId: null,
    activeView: 'terminal',
    activePendingCreationId: null,
    pendingWorktreeCreations: {},
    ...overrides
  }
}

function pendingChat(repoId: string, hostId?: ExecutionHostId): PendingWorktreeCreation {
  return {
    creationId: 'c1',
    phase: 'creating',
    status: 'creating',
    startedAt: 1,
    indeterminate: false,
    loaderVisible: true,
    request: {
      agentLaunchRoute: 'structured-native-chat',
      agent: 'codex',
      repoId,
      name: 'Chat',
      setupDecision: 'skip',
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null,
      ...(hostId
        ? {
            workspaceRunContext: {
              kind: 'workspace-run',
              projectId: 'p',
              projectHostSetupId: 's',
              repoId,
              path: '/repo',
              hostId
            }
          }
        : {})
    }
  }
}

describe('visibleAccountHostId', () => {
  it('follows the selected workspace', () => {
    expect(visibleAccountHostId(state())).toBe('runtime:m4')
  })

  it('follows a new chat started on this computer over a selected remote workspace', () => {
    const shown = state({
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: { c1: pendingChat('local-repo') }
    })
    expect(visibleAccountHostId(shown)).toBe('local')
  })

  it('follows a new chat started on a remote host over a selected local workspace', () => {
    const shown = state({
      activeWorktreeId: LOCAL_WORKTREE,
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: { c1: pendingChat('local-repo', 'runtime:m4') }
    })
    expect(visibleAccountHostId(shown)).toBe('runtime:m4')
  })

  it('ignores a pending chat that is not on screen', () => {
    const hidden = state({
      activeView: 'settings',
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: { c1: pendingChat('local-repo') }
    })
    expect(visibleAccountHostId(hidden)).toBe('runtime:m4')
  })
  it('does not infer local or the default remote for a visible missing owner', () => {
    const shown = state({
      settings: { activeRuntimeEnvironmentId: 'other-server' },
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: { c1: pendingChat('missing') }
    })
    expect(visibleAccountHostId(shown)).toBeNull()
  })

  it('keeps direct SSH as a distinct owner without a paired RPC route', () => {
    const shown = state({
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: { c1: pendingChat('local-repo', 'ssh:machine') }
    })
    expect(visibleAccountHostId(shown)).toBe('ssh:machine')
  })

  it('honors executionHostId before the source host and qualifies its checkout', () => {
    const pending = pendingChat('local-repo', 'runtime:m4')
    const shown = state({
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: {
        c1: { ...pending, request: { ...pending.request, executionHostId: 'local' } }
      }
    })
    expect(pendingChatAccountOwner(shown, 'c1')).toEqual({
      hostId: 'local',
      sourceWorktreeId: 'local-repo::/Users/me/app'
    })
  })

  it('ignores a non-native pending creation and resumes the workspace on completion', () => {
    const pending = pendingChat('local-repo')
    expect(
      visibleAccountHostId(
        state({
          activePendingCreationId: 'c1',
          pendingWorktreeCreations: {
            c1: { ...pending, request: { ...pending.request, agentLaunchRoute: 'terminal-tui' } }
          }
        })
      )
    ).toBe('runtime:m4')
    expect(
      visibleAccountHostId(state({ activePendingCreationId: 'c1', pendingWorktreeCreations: {} }))
    ).toBe('runtime:m4')
  })

  it('routes by the focused split group instead of a sibling chat', () => {
    const shown = state({
      activeGroupIdByWorktree: { [REMOTE_WORKTREE]: 'right' },
      groupsByWorktree: {
        [REMOTE_WORKTREE]: [
          { id: 'left', activeTabId: 'a' },
          { id: 'right', activeTabId: 'b' }
        ]
      },
      unifiedTabsByWorktree: {
        [REMOTE_WORKTREE]: [
          { id: 'a', executionHostId: 'runtime:m4' },
          { id: 'b', executionHostId: 'local' }
        ]
      }
    })
    expect(visibleAccountHostId(shown)).toBe('local')
  })

  it('refuses ambiguous repo twins and resolves an explicit matching source', () => {
    const shown = state({
      activePendingCreationId: 'c1',
      pendingWorktreeCreations: { c1: pendingChat('twin') },
      repos: [
        { id: 'twin', path: '/local', executionHostId: 'local' },
        { id: 'twin', path: '/remote', executionHostId: 'runtime:m4' }
      ]
    })
    expect(visibleAccountHostId(shown)).toBeNull()
    shown.pendingWorktreeCreations.c1.request.executionHostId = 'runtime:m4'
    expect(pendingChatAccountOwner(shown, 'c1')).toEqual({
      hostId: 'runtime:m4',
      sourceWorktreeId: 'twin::/remote'
    })
  })
  it('uses the focused production tab retained as drawn over a newer main frame', () => {
    const tab: Tab = {
      id: 'chat',
      entityId: 'session',
      contentType: 'agent-session',
      worktreeId: REMOTE_WORKTREE,
      groupId: 'right',
      executionHostId: 'runtime:m4',
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const drawn: LayoutFrameSlices = {
      unifiedTabsByWorktree: { [REMOTE_WORKTREE]: [tab] },
      groupsByWorktree: {
        [REMOTE_WORKTREE]: [
          { id: 'right', worktreeId: REMOTE_WORKTREE, tabOrder: ['chat'], activeTabId: 'chat' }
        ]
      },
      activeGroupIdByWorktree: { [REMOTE_WORKTREE]: 'right' },
      layoutByWorktree: {},
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      activeTabIdByWorktree: {},
      openFiles: [],
      editorDrafts: {},
      markdownFrontmatterVisible: {},
      activeFileIdByWorktree: {},
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      remoteBrowserPageHandlesByPageId: {},
      activeBrowserTabIdByWorktree: {},
      activeTabTypeByWorktree: {}
    }
    const built: LayoutFrameSlices = {
      ...drawn,
      unifiedTabsByWorktree: { [REMOTE_WORKTREE]: [{ ...tab, executionHostId: 'local' }] }
    }
    const held = withHeldTabsAsDrawn(drawn, built, [REMOTE_WORKTREE], {
      isTabHeld: (_workspace, id) => id === 'chat',
      isGroupLayoutHeld: () => true
    })
    expect(visibleAccountHostId(state({ ...held }))).toBe('runtime:m4')
    expect(visibleAccountHostId(state({ ...built }))).toBe('local')
  })

  it('updates indexed focused ownership in a large immutable tab catalog', () => {
    const tabs = Array.from({ length: 20_000 }, (_, i) => ({
      id: `t${i}`,
      executionHostId: 'runtime:m4' as const
    }))
    const groups = Array.from({ length: 1_000 }, (_, i) => ({
      id: `g${i}`,
      activeTabId: `t${i * 20 + 19}`
    }))
    const shown = state({
      activeGroupIdByWorktree: { [REMOTE_WORKTREE]: 'g999' },
      groupsByWorktree: { [REMOTE_WORKTREE]: groups },
      unifiedTabsByWorktree: { [REMOTE_WORKTREE]: tabs }
    })
    expect(visibleAccountHostId(shown)).toBe('runtime:m4')
    expect(
      visibleAccountHostId({
        ...shown,
        unifiedTabsByWorktree: {
          [REMOTE_WORKTREE]: [...tabs.slice(0, -1), { id: 't19999', executionHostId: 'local' }]
        }
      })
    ).toBe('local')
    expect(visibleAccountHostId(shown)).toBe('runtime:m4')
  })

  it.each([REMOTE_WORKTREE, LOCAL_WORKTREE])(
    'preserves legacy ownership for unstamped tabs in %s',
    (workspace) => {
      const shown = state({
        activeWorktreeId: workspace,
        activeGroupIdByWorktree: { [workspace]: 'g' },
        groupsByWorktree: { [workspace]: [{ id: 'g', activeTabId: 'old' }] },
        unifiedTabsByWorktree: { [workspace]: [{ id: 'old' }] }
      })
      expect(visibleAccountHostId(shown)).toBe(
        workspace === REMOTE_WORKTREE ? 'runtime:m4' : 'local'
      )
    }
  )
})

describe('nativeChatSurfaceVisible', () => {
  const retainedChat = {
    activeGroupIdByWorktree: { [REMOTE_WORKTREE]: 'g' },
    groupsByWorktree: { [REMOTE_WORKTREE]: [{ id: 'g', activeTabId: 'chat' }] },
    unifiedTabsByWorktree: {
      [REMOTE_WORKTREE]: [
        {
          id: 'chat',
          executionHostId: 'runtime:m4' as const,
          contentType: 'agent-session' as const
        }
      ]
    }
  }

  it('is true for a focused chat tab and false once another view covers it', () => {
    expect(nativeChatSurfaceVisible({ ...state(), ...retainedChat })).toBe(true)
    expect(
      nativeChatSurfaceVisible({ ...state({ activeView: 'settings' }), ...retainedChat })
    ).toBe(false)
  })

  it('follows the shown creation panel, not the chat left selected under it', () => {
    const chat = pendingChat('local-repo')
    const terminal: PendingWorktreeCreation = {
      ...chat,
      request: { ...chat.request, agentLaunchRoute: 'terminal-tui' }
    }
    const creating = (entry: PendingWorktreeCreation) => ({
      ...state({ activePendingCreationId: 'c1', pendingWorktreeCreations: { c1: entry } }),
      ...retainedChat
    })
    expect(nativeChatSurfaceVisible(creating(chat))).toBe(true)
    expect(visibleAccountHostId(creating(chat))).toBe('local')
    expect(nativeChatSurfaceVisible(creating(terminal))).toBe(false)
    expect(visibleAccountHostId(creating(terminal))).toBe('runtime:m4')
  })
})
