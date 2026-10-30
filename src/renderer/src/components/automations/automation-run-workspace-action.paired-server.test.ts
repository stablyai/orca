/** Paired runs use server PTY IDs while local mirrors use terminal handles; comparing those IDs falsely made available run terminals appear missing (#21213). */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import type { Tab } from '../../../../shared/tab-types'
import type { AutomationRun } from '../../../../shared/automations-types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  const chatTabs: Tab[] = []
  return {
    state,
    chatTabs,
    activateTab: vi.fn(),
    rpc: vi.fn(),
    toastError: vi.fn(),
    toastMessage: vi.fn(),
    activateAndRevealWorktree: vi.fn(() => true),
    activateWebRuntimeSessionTab: vi.fn(async () => true),
    activateTerminalTabOnOwner: vi.fn()
  }
})

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: mocks.toastMessage } }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.state } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: mocks.activateWebRuntimeSessionTab
}))
vi.mock('@/lib/terminal-tab-owner-activation', () => ({
  activateTerminalTabOnOwner: mocks.activateTerminalTabOnOwner
}))

import { createAutomationRunWorkspaceAction } from './automation-run-workspace-action'
import { makeAutomationListRow, makeWorktree } from './automations-page-fixtures'
import {
  activateAiVaultStructuredSession,
  openDesktopStructuredSession
} from '@/lib/activate-ai-vault-structured-session'

const ENV = 'env-a'
const WT = 'repo-a::/srv/app'
const GROUP = 'recorded-chat-group'
const LEAF = '11111111-1111-4111-8111-111111111111'
const HOST_TAB = 'host-tab-1'
const MIRRORED_TAB = toWebTerminalSurfaceTabId(HOST_TAB)
const MIRRORED_PTY = toRemoteRuntimePtyId('term-handle-1', ENV)
const worktree = makeWorktree({ id: WT, repoId: 'repo-a', hostId: `runtime:${ENV}` })

const run: AutomationRun = {
  id: 'run-1',
  automationId: 'automation-1',
  title: 'Run 1',
  scheduledFor: 1,
  status: 'completed',
  trigger: 'manual',
  workspaceId: WT,
  workspaceDisplayName: 'app',
  sessionKind: 'terminal',
  chatSessionId: null,
  terminalSessionId: HOST_TAB,
  terminalPaneKey: `${HOST_TAB}:${LEAF}`,
  // The server's own PTY id, which this client never sees.
  terminalPtyId: 'pty-on-server-7',
  outputSnapshot: null,
  precheckResult: null,
  usage: null,
  error: null,
  startedAt: 1,
  dispatchedAt: 1,
  createdAt: 1
}

function storeState(mirrored: boolean): Record<string, unknown> {
  return {
    // Focus is on this computer: owner routing must not depend on it.
    settings: { activeRuntimeEnvironmentId: null },
    activeWorktreeId: null,
    wslMovedProjects: [],
    repos: [{ id: 'repo-a', executionHostId: `runtime:${ENV}` }],
    worktreesByRepo: { 'repo-a': [{ ...worktree, runtimeOwnerEnvironmentId: ENV }] },
    getTab: (tabId: string) => (mirrored && tabId === MIRRORED_TAB ? { id: tabId } : undefined),
    terminalLayoutsByTabId: mirrored
      ? {
          [MIRRORED_TAB]: {
            root: { type: 'leaf', leafId: LEAF },
            activeLeafId: LEAF,
            expandedLeafId: null,
            ptyIdsByLeafId: { [LEAF]: MIRRORED_PTY }
          }
        }
      : {},
    ptyIdsByTabId: mirrored ? { [MIRRORED_TAB]: [MIRRORED_PTY] } : {},
    unifiedTabsByWorktree: { [WT]: mocks.chatTabs },
    activateTab: mocks.activateTab,
    focusGroup: vi.fn(),
    groupsByWorktree: {
      [WT]: [
        {
          ...makeTabGroup({ id: GROUP, worktreeId: WT }),
          get tabOrder() {
            return mocks.chatTabs.map((tab) => tab.id)
          },
          get activeTabId() {
            return mocks.chatTabs[0]?.id ?? null
          }
        }
      ]
    },
    activeGroupIdByWorktree: { [WT]: GROUP },
    setTabLayout: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
}

function openRun(target: AutomationRun = run): void {
  createAutomationRunWorkspaceAction({
    store: { repoForRow: () => undefined, worktreeForRow: () => worktree },
    list: { selectedRow: makeAutomationListRow() }
  })(target)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.chatTabs.length = 0
  mocks.activateAndRevealWorktree.mockImplementation((workspace?: string) => {
    mocks.state.activeWorktreeId = workspace
    return true
  })
  mocks.rpc.mockImplementation(async (_target, method, params) => {
    if (method === 'orchestration.partyLocation') {
      return {
        location: {
          kind: 'chat',
          sessionId: params.address.slice('orca_session_id:'.length),
          worktreeId: WT
        }
      }
    }
    if (method === 'agentSession.reveal') {
      mocks.chatTabs.push(
        makeUnifiedTab({
          id: 'recorded-chat',
          groupId: GROUP,
          entityId: params.sessionId,
          worktreeId: WT,
          executionHostId: `runtime:${ENV}`,
          contentType: 'agent-session'
        })
      )
    }
    return { ok: true, sessionId: params.sessionId, workspaceId: WT, agent: 'codex' }
  })
})

describe('opening a paired-server automation run', () => {
  it('opens the mirrored pane of the run', () => {
    mocks.state = storeState(true)

    openRun()

    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.state.setActiveTab).toHaveBeenCalledWith(MIRRORED_TAB)
    expect(mocks.activateTerminalTabOnOwner).toHaveBeenCalledWith(WT, MIRRORED_TAB, LEAF)
  })

  it('asks the server to open the pane when the mirror has not loaded it yet', async () => {
    mocks.state = storeState(false)

    openRun()
    await vi.waitFor(() => expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalled())

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(WT)
    expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, tabId: HOST_TAB, environmentId: ENV, leafId: LEAF })
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('says the terminal is unavailable only when the server has no such pane', async () => {
    mocks.state = storeState(false)
    mocks.activateWebRuntimeSessionTab.mockResolvedValueOnce(false)

    openRun()

    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Run terminal is unavailable.')
    )
  })

  it('asks the server to open a run whose pane it slept, PTY id dropped', async () => {
    mocks.state = storeState(false)

    openRun({ ...run, terminalPtyId: null })
    await vi.waitFor(() => expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalled())

    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(WT)
    expect(mocks.activateWebRuntimeSessionTab).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, tabId: HOST_TAB, environmentId: ENV, leafId: LEAF })
    )
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })
})

it('opens the recorded Chat on its owning paired server without creating a session or terminal', async () => {
  Object.assign(mocks.state, storeState(false))
  openRun({
    ...run,
    sessionKind: 'chat',
    chatSessionId: 'codex_recorded_chat',
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null
  })
  await vi.waitFor(() =>
    expect(mocks.activateTab).toHaveBeenCalledWith('recorded-chat', { worktreeId: WT })
  )
  expect(mocks.state.focusGroup).toHaveBeenCalledWith(WT, GROUP)
  expect(mocks.rpc).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: ENV },
    'agentSession.reveal',
    { sessionId: 'codex_recorded_chat' },
    expect.any(Object)
  )
})

it('keeps Run Details output and opens the workspace when the recorded chat is gone', async () => {
  mocks.activateTab.mockClear()
  Object.assign(mocks.state, storeState(false))
  mocks.rpc.mockResolvedValue({ location: null, lost: 'chat' })
  openRun({
    ...run,
    sessionKind: 'chat',
    chatSessionId: 'claude_missing',
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null
  })
  await vi.waitFor(() =>
    expect(mocks.toastMessage).toHaveBeenCalledWith(expect.stringContaining('saved output remains'))
  )
  expect(mocks.activateTab).not.toHaveBeenCalled()
})

it.each(['terminal', 'chat'] as const)(
  'opens the actual published %s target even when delivery failed',
  async (kind) => {
    Object.assign(mocks.state, storeState(false))
    mocks.activateTab.mockClear()
    mocks.activateWebRuntimeSessionTab.mockClear()
    const failed = {
      ...run,
      status: 'dispatch_failed' as const,
      error: 'Prompt delivery could not be confirmed.',
      sessionKind: kind,
      ...(kind === 'chat'
        ? {
            chatSessionId: 'claude_published',
            terminalSessionId: null,
            terminalPaneKey: null,
            terminalPtyId: null
          }
        : {})
    }
    openRun(failed)
    await vi.waitFor(() =>
      expect(
        kind === 'chat' ? mocks.activateTab : mocks.activateWebRuntimeSessionTab
      ).toHaveBeenCalledOnce()
    )
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith(WT)
  }
)

it('presents one semantic automation fallback for a real exact activation throw and permits retry', async () => {
  Object.assign(mocks.state, storeState(false))
  mocks.chatTabs.push(
    makeUnifiedTab({
      id: 'recorded-chat',
      groupId: GROUP,
      entityId: 'claude_published',
      worktreeId: WT,
      executionHostId: `runtime:${ENV}`,
      contentType: 'agent-session'
    })
  )
  mocks.state.focusGroup = vi.fn(() => {
    throw new Error('activation unavailable')
  })
  const recorded = {
    ...run,
    sessionKind: 'chat' as const,
    chatSessionId: 'claude_published',
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null
  }
  openRun(recorded)
  openRun(recorded)
  await vi.waitFor(() =>
    expect(mocks.toastMessage).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('saved output remains')
    )
  )
  expect(mocks.toastError).not.toHaveBeenCalled()
  expect(mocks.activateWebRuntimeSessionTab).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(WT)
  mocks.state.focusGroup = vi.fn()
  openRun(recorded)
  await vi.waitFor(() => expect(mocks.activateTab).toHaveBeenCalledOnce())
  expect(mocks.toastMessage).toHaveBeenCalledOnce()
})

it.each([false, true])(
  'opens actual successor/provider with only first-owner navigation, including late joins; History first=%s',
  async (historyFirst) => {
    Object.assign(mocks.state, storeState(false))
    const requested = 'claude_recorded'
    const actualWorkspace = 'repo-a::/srv/successor'
    const actualSession = 'codex_successor'
    const recorded: AutomationRun = {
      ...run,
      sessionKind: 'chat',
      chatSessionId: requested,
      terminalSessionId: null,
      terminalPaneKey: null,
      terminalPtyId: null,
      outputSnapshot: {
        format: 'plain_text',
        content: 'Saved output',
        truncated: false,
        capturedAt: 1
      }
    }
    const before = structuredClone(recorded)
    const target = { kind: 'environment', environmentId: ENV } as const
    const pointer = { workspaceId: WT, sessionId: requested }
    const release = Promise.withResolvers<void>()
    const revealing = Promise.withResolvers<void>()
    const actualTabs: Tab[] = []
    mocks.state.unifiedTabsByWorktree = { [WT]: mocks.chatTabs, [actualWorkspace]: actualTabs }
    mocks.rpc.mockImplementation(async (_target, method: string) => {
      if (method === 'orchestration.partyLocation') {
        return { location: { kind: 'chat', sessionId: actualSession, worktreeId: actualWorkspace } }
      }
      if (method === 'agentSession.reveal') {
        revealing.resolve()
        await release.promise
        // A late stale requested row must not replace the actual receipt/provider.
        mocks.chatTabs.push(
          makeUnifiedTab({
            id: 'stale-requested',
            groupId: GROUP,
            entityId: requested,
            worktreeId: WT,
            executionHostId: `runtime:${ENV}`,
            contentType: 'agent-session'
          })
        )
        actualTabs.push(
          makeUnifiedTab({
            id: 'actual-issued',
            groupId: GROUP,
            entityId: actualSession,
            worktreeId: actualWorkspace,
            executionHostId: `runtime:${ENV}`,
            contentType: 'agent-session',
            agentSessionAgent: 'codex'
          })
        )
        return { ok: true, sessionId: actualSession, workspaceId: actualWorkspace, agent: 'codex' }
      }
      return { ok: true }
    })
    const late: string[] = []
    mocks.activateAndRevealWorktree.mockImplementation((workspace?: string) => {
      mocks.state.activeWorktreeId = workspace
      if (workspace === actualWorkspace) {
        late.push('sync')
        openRun(recorded)
        queueMicrotask(() => {
          late.push('microtask')
          openRun(recorded)
        })
      }
      return true
    })
    const history = () =>
      activateAiVaultStructuredSession({ structuredSession: pointer }, undefined, target)
    let handled: Promise<boolean>
    if (historyFirst) {
      handled = history()
      await revealing.promise
      openRun(recorded)
    } else {
      openRun(recorded)
      await revealing.promise
      handled = history()
    }
    const rich = openDesktopStructuredSession(
      { kind: 'history', structuredSession: pointer },
      target
    )
    release.resolve()
    expect(await handled).toBe(true)
    expect(await rich).toEqual({
      kind: 'opened',
      target: { sessionId: actualSession, worktreeId: actualWorkspace, agent: 'codex' },
      tab: { id: 'actual-issued', sessionId: actualSession, agent: 'codex' }
    })
    expect(late).toEqual(['sync', 'microtask'])
    expect(mocks.state.activeWorktreeId).toBe(actualWorkspace)
    expect(mocks.activateAndRevealWorktree.mock.calls).toEqual(
      historyFirst ? [[actualWorkspace]] : [[WT], [actualWorkspace]]
    )
    expect(mocks.activateTab).toHaveBeenCalledExactlyOnceWith('actual-issued', {
      worktreeId: actualWorkspace
    })
    expect(mocks.state.focusGroup).toHaveBeenCalledExactlyOnceWith(actualWorkspace, GROUP)
    expect(
      mocks.rpc.mock.calls.filter(([, method]) => method === 'agentSession.reveal')
    ).toHaveLength(1)
    expect(
      mocks.rpc.mock.calls.filter(([, method]) => method === 'session.tabs.activate')
    ).toHaveLength(1)
    expect(mocks.rpc.mock.calls.every(([, method]) => !/create|send|launch/.test(method))).toBe(
      true
    )
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastMessage).not.toHaveBeenCalled()
    expect(recorded).toEqual(before)
  }
)

it('refuses owner-only workspace initialization before engine and releases for a real retry', async () => {
  Object.assign(mocks.state, storeState(false))
  const recorded: AutomationRun = {
    ...run,
    sessionKind: 'chat',
    chatSessionId: 'claude_recorded',
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null
  }
  mocks.activateAndRevealWorktree.mockReturnValueOnce(false)
  openRun(recorded)
  openRun(recorded)
  const result = await openDesktopStructuredSession(
    {
      kind: 'history',
      structuredSession: {
        workspaceId: WT,
        sessionId: 'claude_recorded'
      }
    },
    { kind: 'environment', environmentId: ENV }
  )
  expect(result).toEqual({
    kind: 'failed',
    failure: { reason: 'unreachable', beforeEffects: true }
  })
  expect(mocks.activateAndRevealWorktree).toHaveBeenCalledExactlyOnceWith(WT)
  expect(mocks.toastError).toHaveBeenCalledExactlyOnceWith('Workspace is not available.')
  expect(mocks.toastMessage).not.toHaveBeenCalled()
  expect(mocks.rpc).not.toHaveBeenCalled()
  expect(mocks.activateTab).not.toHaveBeenCalled()
  openRun(recorded)
  await vi.waitFor(() => expect(mocks.activateTab).toHaveBeenCalledOnce())
  expect(mocks.toastError).toHaveBeenCalledOnce()
  expect(mocks.toastMessage).not.toHaveBeenCalled()
})
