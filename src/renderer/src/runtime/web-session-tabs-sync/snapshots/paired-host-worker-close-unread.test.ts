import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { composeWorktreeId } from '../../../../../shared/worktree/id'
import { useAppStore } from '../../../store/index'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'
import { makeTab } from '../../../store/terminals/testing/terminal-tab.test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { resetWebSessionTabsSyncTestState } from '../testing/web-session-tabs-sync.test-fixture'
import { createWebSessionTabsSnapshotPatch } from './snapshot-api'
import { applyWebSessionTabsStorePatch } from './store-patch'

vi.mock('@/store/slices/worktrees/metadata/worktree-meta-persist', () => ({
  persistWorktreeMeta: vi.fn(async () => undefined)
}))

const ENV = 'paired-ssh-1'
const HOST = toRuntimeExecutionHostId(ENV)
const LEAF = '11111111-1111-4111-8111-111111111111'
const KEPT_LEAF = '22222222-2222-4222-8222-222222222222'
const CLOSED_WORKSPACE = composeWorktreeId('repo1', '/tmp/paired-closed')
const KEPT_WORKSPACE = composeWorktreeId('repo1', '/tmp/paired-kept')
const CLOSED_HOST_TAB = 'worker-tab'
const KEPT_HOST_TAB = 'sibling-tab'
const CLOSED_TAB = toWebTerminalSurfaceTabId(CLOSED_HOST_TAB)
const KEPT_TAB = toWebTerminalSurfaceTabId(KEPT_HOST_TAB)
const CLOSED_PANE = makePaneKey(CLOSED_TAB, LEAF)
const KEPT_PANE = makePaneKey(KEPT_TAB, KEPT_LEAF)

function emptySnapshot(worktree: string, publicationEpoch: string): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch,
    snapshotVersion: 2,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: 'terminal',
    tabs: []
  }
}

function keptSnapshot(): RuntimeMobileSessionTabsResult {
  return {
    worktree: KEPT_WORKSPACE,
    publicationEpoch: 'epoch-kept',
    snapshotVersion: 2,
    activeGroupId: null,
    activeTabId: `${KEPT_HOST_TAB}::${KEPT_LEAF}`,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `${KEPT_HOST_TAB}::${KEPT_LEAF}`,
        parentTabId: KEPT_HOST_TAB,
        leafId: KEPT_LEAF,
        title: 'sibling',
        status: 'ready',
        terminal: 'term-sibling',
        isActive: true
      }
    ]
  }
}

function applySnapshot(snapshot: RuntimeMobileSessionTabsResult): void {
  applyWebSessionTabsStorePatch(createWebSessionTabsSnapshotPatch(snapshot, ENV), {
    frames: [
      {
        environmentId: ENV,
        worktreeId: snapshot.worktree,
        source: snapshot,
        decision: { apply: true, settlesHostMirror: false }
      }
    ]
  })
}

function workspaceUnread(worktreeId: string): boolean {
  return (
    useAppStore.getState().worktreesByRepo.repo1?.find((worktree) => worktree.id === worktreeId)
      ?.isUnread === true
  )
}

describe('paired host snapshot closing a dispatched worker', () => {
  const initialState = useAppStore.getState()

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    useAppStore.setState(initialState, true)
    const closedPty = toRemoteRuntimePtyId('term-worker', ENV)
    const keptPty = toRemoteRuntimePtyId('term-sibling', ENV)
    useAppStore.setState({
      repos: [{ ...TEST_REPO, executionHostId: HOST }],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: CLOSED_WORKSPACE,
            repoId: 'repo1',
            hostId: HOST,
            runtimeOwnerEnvironmentId: ENV,
            isUnread: false
          }),
          makeWorktree({
            id: KEPT_WORKSPACE,
            repoId: 'repo1',
            hostId: HOST,
            runtimeOwnerEnvironmentId: ENV,
            isUnread: false
          })
        ]
      },
      tabsByWorktree: {
        [CLOSED_WORKSPACE]: [
          makeTab({ id: CLOSED_TAB, worktreeId: CLOSED_WORKSPACE, ptyId: closedPty })
        ],
        [KEPT_WORKSPACE]: [makeTab({ id: KEPT_TAB, worktreeId: KEPT_WORKSPACE, ptyId: keptPty })]
      },
      ptyIdsByTabId: {
        [CLOSED_TAB]: [closedPty],
        [KEPT_TAB]: [keptPty]
      },
      terminalLayoutsByTabId: {
        [CLOSED_TAB]: {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: closedPty }
        },
        [KEPT_TAB]: {
          root: { type: 'leaf', leafId: KEPT_LEAF },
          activeLeafId: KEPT_LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [KEPT_LEAF]: keptPty }
        }
      }
    })
    const { markAgentAttentionUnread } = useAppStore.getState()
    markAgentAttentionUnread({
      workspaceId: CLOSED_WORKSPACE,
      subjectKey: CLOSED_PANE,
      groupId: null,
      reason: 'agent-completion'
    })
    markAgentAttentionUnread({
      workspaceId: KEPT_WORKSPACE,
      subjectKey: KEPT_PANE,
      groupId: null,
      reason: 'agent-completion'
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
    resetWebSessionTabsSyncTestState()
  })

  it('clears the sidebar unread dot when the host snapshot drops the worker tab', () => {
    expect(workspaceUnread(CLOSED_WORKSPACE)).toBe(true)
    expect(useAppStore.getState().unreadAgentCompletionPanes[CLOSED_PANE]).toBe('agent-completion')

    applySnapshot(emptySnapshot(CLOSED_WORKSPACE, 'epoch-closed'))

    const state = useAppStore.getState()
    expect(state.tabsByWorktree[CLOSED_WORKSPACE] ?? []).toEqual([])
    expect(state.unreadAgentCompletionPanes[CLOSED_PANE]).toBeUndefined()
    expect(workspaceUnread(CLOSED_WORKSPACE)).toBe(false)
    expect(state.tabsByWorktree[KEPT_WORKSPACE]?.map((tab) => tab.id)).toEqual([KEPT_TAB])
    expect(state.unreadAgentCompletionPanes[KEPT_PANE]).toBe('agent-completion')
    expect(workspaceUnread(KEPT_WORKSPACE)).toBe(true)
  })

  it('keeps the dot when another unread tab in the same workspace remains', () => {
    const siblingPty = toRemoteRuntimePtyId('term-other', ENV)
    const siblingTab = toWebTerminalSurfaceTabId('other-tab')
    const siblingPane = makePaneKey(siblingTab, KEPT_LEAF)
    useAppStore.setState({
      tabsByWorktree: {
        ...useAppStore.getState().tabsByWorktree,
        [CLOSED_WORKSPACE]: [
          ...(useAppStore.getState().tabsByWorktree[CLOSED_WORKSPACE] ?? []),
          makeTab({ id: siblingTab, worktreeId: CLOSED_WORKSPACE, ptyId: siblingPty })
        ]
      },
      ptyIdsByTabId: {
        ...useAppStore.getState().ptyIdsByTabId,
        [siblingTab]: [siblingPty]
      },
      terminalLayoutsByTabId: {
        ...useAppStore.getState().terminalLayoutsByTabId,
        [siblingTab]: {
          root: { type: 'leaf', leafId: KEPT_LEAF },
          activeLeafId: KEPT_LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [KEPT_LEAF]: siblingPty }
        }
      }
    })
    useAppStore.getState().markAgentAttentionUnread({
      workspaceId: CLOSED_WORKSPACE,
      subjectKey: siblingPane,
      groupId: null,
      reason: 'agent-completion'
    })

    applySnapshot({
      ...keptSnapshot(),
      worktree: CLOSED_WORKSPACE,
      publicationEpoch: 'epoch-sibling',
      tabs: [
        {
          type: 'terminal',
          id: `other-tab::${KEPT_LEAF}`,
          parentTabId: 'other-tab',
          leafId: KEPT_LEAF,
          title: 'other',
          status: 'ready',
          terminal: 'term-other',
          isActive: true
        }
      ],
      activeTabId: `other-tab::${KEPT_LEAF}`
    })

    const state = useAppStore.getState()
    expect(state.tabsByWorktree[CLOSED_WORKSPACE]?.map((tab) => tab.id)).toEqual([siblingTab])
    expect(state.unreadAgentCompletionPanes[CLOSED_PANE]).toBeUndefined()
    expect(state.unreadAgentCompletionPanes[siblingPane]).toBe('agent-completion')
    expect(workspaceUnread(CLOSED_WORKSPACE)).toBe(true)
  })

  it('does not clear the dot for an unpublished empty host frame', () => {
    expect(workspaceUnread(CLOSED_WORKSPACE)).toBe(true)

    applySnapshot(emptySnapshot(CLOSED_WORKSPACE, UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH))

    const state = useAppStore.getState()
    expect(state.unreadAgentCompletionPanes[CLOSED_PANE]).toBe('agent-completion')
    expect(workspaceUnread(CLOSED_WORKSPACE)).toBe(true)

    applySnapshot(emptySnapshot(CLOSED_WORKSPACE, 'epoch-affirmed'))

    expect(workspaceUnread(CLOSED_WORKSPACE)).toBe(false)
  })

  it('keeps a dot the user marked after the host drops the last tab', () => {
    useAppStore.getState().setWorkspaceUnreadByUser(CLOSED_WORKSPACE, true, HOST)

    applySnapshot(emptySnapshot(CLOSED_WORKSPACE, 'epoch-manual'))

    expect(useAppStore.getState().tabsByWorktree[CLOSED_WORKSPACE] ?? []).toEqual([])
    expect(workspaceUnread(CLOSED_WORKSPACE)).toBe(true)
  })
})
