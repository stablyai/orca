/* eslint-disable max-lines */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type {
  GitHubWorkItem,
  LinearIssue,
  PersistedUIState,
  TerminalTab,
  Worktree,
  WorktreeCardProperty
} from '../../../../shared/types'
import { createUISlice } from './ui'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import { createSettingsSearchState } from './settings-search-state'
import type { AppState } from '../types'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

const mocks = vi.hoisted(() => ({
  sendBracketedPasteToRunningAgent: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/agent-paste-draft', () => ({
  sendBracketedPasteToRunningAgent: mocks.sendBracketedPasteToRunningAgent
}))

vi.mock('@/lib/telemetry', () => ({
  track: mocks.track
}))

vi.mock('sonner', () => ({
  toast: {
    message: mocks.toastMessage,
    success: mocks.toastSuccess,
    error: mocks.toastError
  }
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

beforeEach(() => {
  mocks.sendBracketedPasteToRunningAgent.mockReset()
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

function createUIStore(): StoreApi<AppState> {
  // Only the UI slice, repo/worktree ids, and right sidebar width fallback are
  // needed for these tests. The worktree-nav-history slice is also included
  // because page opens record view visits.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    worktreesByRepo: {},
    rightSidebarOpen: false,
    rightSidebarWidth: 280,
    ...createSettingsSearchState(args[0]),
    ...createWorktreeNavHistorySlice(...(args as Parameters<typeof createWorktreeNavHistorySlice>)),
    ...createUISlice(...(args as Parameters<typeof createUISlice>))
  })) as unknown as StoreApi<AppState>
}

function makeWorktree(id: string): Worktree {
  return { id } as unknown as Worktree
}

function makeAgentEntry(paneKey: string, stateStartedAt: number): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Review complete',
    updatedAt: stateStartedAt,
    stateStartedAt,
    agentType: 'codex',
    paneKey,
    stateHistory: []
  }
}

function makeTerminalTab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId: null,
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: Date.now()
  }
}

function makeGitHubWorkItem(overrides: Partial<GitHubWorkItem> = {}): GitHubWorkItem {
  return {
    id: 'pr-95',
    type: 'pr',
    number: 95,
    title: 'feat: add file upload command',
    state: 'open',
    url: 'https://github.com/acme/repo/pull/95',
    labels: [],
    updatedAt: '2026-05-20T00:00:00.000Z',
    author: 'octocat',
    repoId: 'repo-1',
    ...overrides
  }
}

function makeLinearIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'lin-1',
    identifier: 'ORC-1',
    title: 'Fix task flow',
    url: 'https://linear.app/orca/issue/ORC-1/fix-task-flow',
    state: { name: 'Todo', type: 'unstarted', color: '#999' },
    priority: 0,
    estimate: null,
    assignee: null,
    labels: [],
    labelIds: [],
    team: { id: 'team-1', name: 'Orca', key: 'ORC' },
    workspaceId: 'workspace-1',
    updatedAt: '2026-05-30T00:00:00.000Z',
    createdAt: '2026-05-30T00:00:00.000Z',
    ...overrides
  } as LinearIssue
}

function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return {
    ...getDefaultUIState(),
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe('createUISlice agent send target mode', () => {
  const worktreeId = 'wt-1'
  const tabId = 'tab-1'
  const readyLeafId = '11111111-1111-4111-8111-111111111111'
  const workingLeafId = '22222222-2222-4222-8222-222222222222'
  const readyPaneKey = makePaneKey(tabId, readyLeafId)
  const workingPaneKey = makePaneKey(tabId, workingLeafId)

  function seedAgentSendState(store: StoreApi<AppState>): void {
    const now = Date.now()
    store.setState({
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: tabId,
            worktreeId,
            ptyId: 'fallback-pty',
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: now
          }
        ]
      },
      terminalLayoutsByTabId: {
        [tabId]: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: readyLeafId },
            second: { type: 'leaf', leafId: workingLeafId }
          },
          activeLeafId: readyLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            [readyLeafId]: 'pty-ready',
            [workingLeafId]: 'pty-working'
          }
        }
      },
      agentStatusByPaneKey: {
        [readyPaneKey]: {
          state: 'done',
          prompt: 'previous',
          updatedAt: now,
          stateStartedAt: now,
          agentType: 'codex',
          paneKey: readyPaneKey,
          stateHistory: []
        },
        [workingPaneKey]: {
          state: 'working',
          prompt: 'busy',
          updatedAt: now,
          stateStartedAt: now,
          agentType: 'codex',
          paneKey: workingPaneKey,
          stateHistory: []
        }
      }
    } as Partial<AppState>)
  }

  it('opens target mode with derived eligible and disabled pane keys', () => {
    const store = createUIStore()
    seedAgentSendState(store)

    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this',
      label: 'All unsent notes',
      launchSource: 'notes_send'
    })

    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      eligiblePaneKeys: [readyPaneKey],
      disabledPaneKeys: {
        [workingPaneKey]: 'Agent is working'
      },
      status: 'open'
    })
    expect(store.getState().pendingRevealWorktree).toMatchObject({
      worktreeId,
      behavior: 'auto',
      highlight: true
    })
  })

  it('does not reveal the sidebar when the current workspace has no eligible targets', () => {
    const store = createUIStore()
    seedAgentSendState(store)
    store.setState({
      terminalLayoutsByTabId: {
        [tabId]: {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: readyLeafId },
            second: { type: 'leaf', leafId: workingLeafId }
          },
          activeLeafId: readyLeafId,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      }
    })

    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'browser-annotations',
      prompt: 'Review this',
      label: 'Browser annotations',
      launchSource: 'notes_send'
    })

    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      eligiblePaneKeys: [],
      disabledPaneKeys: {
        [readyPaneKey]: 'Terminal is no longer available',
        [workingPaneKey]: 'Terminal is no longer available'
      }
    })
    expect(store.getState().pendingRevealWorktree).toBeNull()
  })

  it('sends to the live leaf PTY, runs delivery callback, tracks followup, and closes', async () => {
    const store = createUIStore()
    const onPromptDelivered = vi.fn()
    seedAgentSendState(store)
    mocks.sendBracketedPasteToRunningAgent.mockResolvedValue(true)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this',
      label: 'All unsent notes',
      launchSource: 'notes_send',
      onPromptDelivered
    })

    await expect(store.getState().sendPromptToSidebarAgentTarget(readyPaneKey)).resolves.toBe(true)

    expect(mocks.sendBracketedPasteToRunningAgent).toHaveBeenCalledWith({
      ptyId: 'pty-ready',
      content: 'Review this'
    })
    expect(onPromptDelivered).toHaveBeenCalledTimes(1)
    expect(mocks.track).toHaveBeenCalledWith('agent_prompt_sent', {
      agent_kind: 'codex',
      launch_source: 'notes_send',
      request_kind: 'followup'
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sent to Codex')
    expect(store.getState().agentSendPopoverTargetMode).toBeNull()
  })

  it('keeps target mode open and does not run delivery callback when send fails', async () => {
    const store = createUIStore()
    const onPromptDelivered = vi.fn()
    seedAgentSendState(store)
    mocks.sendBracketedPasteToRunningAgent.mockResolvedValue(false)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this',
      label: 'All unsent notes',
      launchSource: 'notes_send',
      onPromptDelivered
    })

    await expect(store.getState().sendPromptToSidebarAgentTarget(readyPaneKey)).resolves.toBe(false)

    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
    expect(mocks.toastError).toHaveBeenCalledWith("Couldn't send to Codex", {
      description: 'Terminal is no longer available'
    })
    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      status: 'error',
      error: 'Terminal is no longer available'
    })
  })

  it('does not send to a working agent row', async () => {
    const store = createUIStore()
    seedAgentSendState(store)
    mocks.sendBracketedPasteToRunningAgent.mockResolvedValue(true)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'browser-annotations',
      prompt: 'Review this',
      label: 'Browser annotations',
      launchSource: 'notes_send'
    })

    await expect(store.getState().sendPromptToSidebarAgentTarget(workingPaneKey)).resolves.toBe(
      false
    )

    expect(mocks.sendBracketedPasteToRunningAgent).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      status: 'open'
    })
  })

  it('does not let an older send close a reopened popover with the same id', async () => {
    const store = createUIStore()
    const write = deferred<boolean>()
    seedAgentSendState(store)
    mocks.sendBracketedPasteToRunningAgent.mockReturnValue(write.promise)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this',
      label: 'All unsent notes',
      launchSource: 'notes_send'
    })

    const send = store.getState().sendPromptToSidebarAgentTarget(readyPaneKey)
    store.getState().closeAgentSendPopoverTargetMode('send-1')
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this again',
      label: 'All unsent notes',
      launchSource: 'notes_send'
    })
    const reopenedMode = store.getState().agentSendPopoverTargetMode

    write.resolve(true)
    await expect(send).resolves.toBe(true)

    expect(store.getState().agentSendPopoverTargetMode).toBe(reopenedMode)
    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      prompt: 'Review this again',
      status: 'open'
    })
  })

  it('does not retarget the same popover while a send is in progress', async () => {
    const store = createUIStore()
    const write = deferred<boolean>()
    seedAgentSendState(store)
    mocks.sendBracketedPasteToRunningAgent.mockReturnValue(write.promise)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this',
      label: 'This file',
      launchSource: 'notes_send'
    })

    const send = store.getState().sendPromptToSidebarAgentTarget(readyPaneKey)
    const sendingMode = store.getState().agentSendPopoverTargetMode
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review everything',
      label: 'All unsent notes',
      launchSource: 'notes_send'
    })

    expect(store.getState().agentSendPopoverTargetMode).toBe(sendingMode)
    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      prompt: 'Review this',
      status: 'sending',
      sendingPaneKey: readyPaneKey
    })

    write.resolve(true)
    await expect(send).resolves.toBe(true)
  })
})

describe('createUISlice acknowledgeAgents notification dismissal', () => {
  const tabId = 'tab-ack'
  const livePaneKey = makePaneKey(tabId, '11111111-1111-4111-8111-111111111111')
  const retainedPaneKey = makePaneKey('tab-retained', '22222222-2222-4222-8222-222222222222')
  const skippedPaneKey = makePaneKey('tab-skipped', '33333333-3333-4333-8333-333333333333')

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-06-02T12:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('dismisses live and retained agent notifications only when the event is unvisited', () => {
    const dismiss = vi.fn().mockResolvedValue({ dismissed: 0 })
    vi.stubGlobal('window', { api: { notifications: { dismiss } } })
    const store = createUIStore()
    store.setState({
      tabsByWorktree: {
        'wt-live': [makeTerminalTab(tabId, 'wt-live')]
      },
      agentStatusByPaneKey: {
        [livePaneKey]: makeAgentEntry(livePaneKey, 1_000),
        [skippedPaneKey]: makeAgentEntry(skippedPaneKey, 3_000)
      },
      retainedAgentsByPaneKey: {
        [retainedPaneKey]: {
          entry: makeAgentEntry(retainedPaneKey, 2_000),
          worktreeId: 'wt-retained',
          tab: makeTerminalTab('tab-retained', 'wt-retained'),
          agentType: 'codex',
          startedAt: 2_000
        }
      },
      acknowledgedAgentsByPaneKey: {
        [skippedPaneKey]: 4_000
      }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([livePaneKey, retainedPaneKey, skippedPaneKey])

    expect(dismiss).toHaveBeenCalledWith([
      buildAgentNotificationId({
        worktreeId: 'wt-live',
        paneKey: livePaneKey,
        stateStartedAt: 1_000
      }),
      buildAgentNotificationId({
        worktreeId: 'wt-retained',
        paneKey: retainedPaneKey,
        stateStartedAt: 2_000
      })
    ])

    dismiss.mockClear()
    vi.setSystemTime(new Date('2026-06-02T12:00:01Z'))
    store.getState().acknowledgeAgents([livePaneKey, retainedPaneKey])

    expect(dismiss).not.toHaveBeenCalled()
  })

  it('falls back to live entry worktree attribution and skips unresolved live entries', () => {
    const dismiss = vi.fn().mockResolvedValue({ dismissed: 0 })
    vi.stubGlobal('window', { api: { notifications: { dismiss } } })
    const store = createUIStore()
    const fallbackPaneKey = makePaneKey('tab-fallback', '44444444-4444-4444-8444-444444444444')
    store.setState({
      tabsByWorktree: {},
      agentStatusByPaneKey: {
        [fallbackPaneKey]: {
          ...makeAgentEntry(fallbackPaneKey, 1_000),
          worktreeId: 'wt-from-entry'
        },
        [livePaneKey]: makeAgentEntry(livePaneKey, 2_000)
      },
      retainedAgentsByPaneKey: {}
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([fallbackPaneKey, livePaneKey])

    expect(dismiss).toHaveBeenCalledWith([
      buildAgentNotificationId({
        worktreeId: 'wt-from-entry',
        paneKey: fallbackPaneKey,
        stateStartedAt: 1_000
      })
    ])
  })

  it('dedupes identical live and retained notification ids for the same pane', () => {
    const dismiss = vi.fn().mockResolvedValue({ dismissed: 0 })
    vi.stubGlobal('window', { api: { notifications: { dismiss } } })
    const store = createUIStore()
    store.setState({
      tabsByWorktree: {
        'wt-live': [makeTerminalTab(tabId, 'wt-live')]
      },
      agentStatusByPaneKey: {
        [livePaneKey]: makeAgentEntry(livePaneKey, 1_000)
      },
      retainedAgentsByPaneKey: {
        [livePaneKey]: {
          entry: makeAgentEntry(livePaneKey, 1_000),
          worktreeId: 'wt-live',
          tab: makeTerminalTab(tabId, 'wt-live'),
          agentType: 'codex',
          startedAt: 1_000
        }
      }
    } as Partial<AppState>)

    store.getState().acknowledgeAgents([livePaneKey])

    expect(dismiss).toHaveBeenCalledWith([
      buildAgentNotificationId({
        worktreeId: 'wt-live',
        paneKey: livePaneKey,
        stateStartedAt: 1_000
      })
    ])
  })
})

describe('createUISlice hydratePersistedUI', () => {
  it('defaults persisted right sidebar visibility to open', () => {
    expect(getDefaultUIState().rightSidebarOpen).toBe(true)
  })

  it('defaults to showing sleeping workspaces', () => {
    const store = createUIStore()

    expect(store.getState().showSleepingWorkspaces).toBe(true)
  })

  it('preserves the current right sidebar width when older persisted UI omits it', () => {
    const store = createUIStore()

    store.setState({ rightSidebarWidth: 360 })
    store.getState().hydratePersistedUI({
      ...makePersistedUI(),
      rightSidebarWidth: undefined as unknown as number
    })

    expect(store.getState().rightSidebarWidth).toBe(360)
  })

  it('hydrates a persisted closed right sidebar preference', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ rightSidebarOpen: false }))

    expect(store.getState().rightSidebarOpen).toBe(false)
  })

  it('hydrates a persisted open right sidebar preference', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ rightSidebarOpen: true }))

    expect(store.getState().rightSidebarOpen).toBe(true)
  })

  it('hydrates a persisted right sidebar tab preference', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ rightSidebarTab: 'checks' }))

    expect(store.getState().rightSidebarTab).toBe('checks')
  })

  it('hydrates persisted per-worktree dotfile visibility', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showDotfilesByWorktree: {
          'repo-1::/repo': false,
          'repo-2::/repo': true
        }
      })
    )

    expect(store.getState().showDotfilesByWorktree).toEqual({
      'repo-1::/repo': false,
      'repo-2::/repo': true
    })
  })

  it('drops invalid persisted per-worktree dotfile visibility entries', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showDotfilesByWorktree: {
          'repo-1::/repo': false,
          'repo-2::/repo': 'nope',
          constructor: false
        } as never
      })
    )

    expect(store.getState().showDotfilesByWorktree).toEqual({ 'repo-1::/repo': false })
  })

  it('stores only per-worktree dotfile visibility opt-outs', () => {
    const store = createUIStore()

    store.getState().setShowDotfilesForWorktree('repo-1::/repo', false)
    expect(store.getState().showDotfilesByWorktree).toEqual({ 'repo-1::/repo': false })

    store.getState().setShowDotfilesForWorktree('repo-1::/repo', true)
    expect(store.getState().showDotfilesByWorktree).toEqual({})
  })

  it('toggles per-worktree dotfile visibility independently', () => {
    const store = createUIStore()

    store.getState().toggleShowDotfilesForWorktree('repo-1::/repo')
    store.getState().toggleShowDotfilesForWorktree('repo-2::/repo')
    store.getState().toggleShowDotfilesForWorktree('repo-2::/repo')

    expect(store.getState().showDotfilesByWorktree).toEqual({ 'repo-1::/repo': false })
  })

  it('falls back to explorer for invalid persisted right sidebar tabs', () => {
    const store = createUIStore()

    store
      .getState()
      .hydratePersistedUI(
        makePersistedUI({ rightSidebarTab: 'bogus' as PersistedUIState['rightSidebarTab'] })
      )

    expect(store.getState().rightSidebarTab).toBe('explorer')
  })

  it('clamps persisted sidebar widths into the supported range', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 100,
        rightSidebarWidth: 100
      })
    )

    expect(store.getState().sidebarWidth).toBe(220)
    expect(store.getState().rightSidebarWidth).toBe(220)
  })

  it('preserves right sidebar widths above the former 500px cap', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 260,
        rightSidebarWidth: 900
      })
    )

    // Left sidebar stays capped; right sidebar now allows wide drag targets
    // so long file names remain readable.
    expect(store.getState().sidebarWidth).toBe(260)
    expect(store.getState().rightSidebarWidth).toBe(900)
  })

  it('stores pending sidebar reveal rename requests', () => {
    const store = createUIStore()

    store.getState().revealWorktreeInSidebar('repo1::/feature', {
      behavior: 'smooth',
      highlight: true,
      beginRename: true
    })

    expect(store.getState().pendingRevealWorktree).toEqual({
      worktreeId: 'repo1::/feature',
      behavior: 'smooth',
      highlight: true,
      beginRename: true
    })
  })

  it('falls back to existing sidebar widths when persisted values are not finite', () => {
    const store = createUIStore()

    store.getState().setSidebarWidth(320)
    store.setState({ rightSidebarWidth: 360 })

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: Number.NaN,
        rightSidebarWidth: Number.POSITIVE_INFINITY
      })
    )

    expect(store.getState().sidebarWidth).toBe(320)
    expect(store.getState().rightSidebarWidth).toBe(360)
  })

  it('does not restore the retired active-only filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showActiveOnly: true
      })
    )

    expect(store.getState().showActiveOnly).toBe(false)
  })

  it('restores the new hide-sleeping filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        hideSleepingWorkspaces: true
      })
    )

    expect(store.getState().showSleepingWorkspaces).toBe(false)
  })

  it('ignores legacy hidden-sleeping preference so existing users start with sleeping visible', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showSleepingWorkspaces: false
      })
    )

    expect(store.getState().showSleepingWorkspaces).toBe(true)
  })

  it('ignores the legacy show-inactive filter so existing users start with sleeping visible', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showSleepingWorkspaces: undefined,
        showInactiveWorkspaces: false
      })
    )

    expect(store.getState().showSleepingWorkspaces).toBe(true)
  })

  it('restores the hide-default-branch filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        hideDefaultBranchWorkspace: true
      })
    )

    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
  })

  it('restores fixed card properties during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        worktreeCardProperties: ['inline-agents']
      })
    )

    expect(store.getState().worktreeCardProperties).toEqual(['status', 'unread', 'inline-agents'])
  })

  it('adds default-on status items once for older persisted UI', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        statusBarItems: ['claude', 'resource-usage'],
        _portsStatusBarDefaultAdded: false
      })
    )

    expect(store.getState().statusBarItems).toEqual(['claude', 'resource-usage', 'ports', 'kimi'])
    expect(setUI).toHaveBeenCalledWith({
      statusBarItems: ['claude', 'resource-usage', 'ports', 'kimi'],
      _portsStatusBarDefaultAdded: true,
      _kimiStatusBarDefaultAdded: true
    })
  })

  it('preserves user-hidden default-on status items after one-shot migrations ran', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        statusBarItems: ['claude', 'resource-usage'],
        _portsStatusBarDefaultAdded: true,
        _kimiStatusBarDefaultAdded: true
      })
    )

    expect(store.getState().statusBarItems).toEqual(['claude', 'resource-usage'])
    expect(setUI).not.toHaveBeenCalled()
  })

  it('clamps persisted workspace board column width', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceBoardColumnWidth: 900
      })
    )

    expect(store.getState().workspaceBoardColumnWidth).toBe(520)
  })

  it('hydrates a valid Kagi session link', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://kagi.com/search?token=secret&q=%s'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBe('https://kagi.com/search?token=secret')
  })

  it('hydrates and normalizes the default browser zoom level', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserDefaultZoomLevel: 1.26
      })
    )

    expect(store.getState().browserDefaultZoomLevel).toBe(1.5)
  })

  it('persists normalized default browser zoom changes', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setBrowserDefaultZoomLevel(10)

    expect(store.getState().browserDefaultZoomLevel).toBe(5)
    expect(setUI).toHaveBeenCalledWith({ browserDefaultZoomLevel: 5 })
  })

  it('drops an invalid Kagi session link during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://example.com/search?token=secret'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBeNull()
  })

  it('hydrates legacy sidekick persisted keys into pet state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        petVisible: undefined,
        petId: undefined,
        petSize: undefined,
        customPets: undefined,
        sidekickVisible: false,
        sidekickId: 'custom-pet',
        sidekickSize: 240,
        customSidekicks: [
          {
            id: 'custom-pet',
            label: 'Legacy pet',
            fileName: 'custom-pet.webp',
            mimeType: 'image/webp',
            kind: 'image'
          }
        ]
      })
    )

    expect(store.getState().petVisible).toBe(false)
    expect(store.getState().petId).toBe('custom-pet')
    expect(store.getState().petSize).toBe(240)
    expect(store.getState().customPets).toEqual([
      {
        id: 'custom-pet',
        label: 'Legacy pet',
        fileName: 'custom-pet.webp',
        mimeType: 'image/webp',
        kind: 'image'
      }
    ])
  })

  it('sanitizes task resume state field-by-field during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        taskResumeState: {
          githubMode: 'project',
          githubItemsPreset: 'invalid',
          githubItemsQuery: 42,
          linearPreset: 'completed',
          linearQuery: 'label:bug',
          jiraPreset: 'reported',
          jiraQuery: 99
        } as unknown as PersistedUIState['taskResumeState']
      })
    )

    expect(store.getState().taskResumeState).toEqual({
      githubMode: 'project',
      linearPreset: 'completed',
      linearQuery: 'label:bug',
      jiraPreset: 'reported'
    })
  })

  it('restores acknowledgedAgentsByPaneKey from persisted UI state', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: { 'tab-a:0': now, 'tab-b:1': now - 5_000 }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 5_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to an empty ack map when persisted UI omits acknowledgedAgentsByPaneKey', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI())

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is null', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          null as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is a string', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          'oops' as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is an array', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey: [
          'a',
          'b'
        ] as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('drops non-number / non-finite / non-positive entries from acknowledgedAgentsByPaneKey', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-a:0': now,
            'tab-b:1': now - 1000,
            'tab-c:2': 'not-a-number',
            'tab-d:3': Number.NaN,
            'tab-e:4': Number.POSITIVE_INFINITY,
            'tab-f:5': -1
          } as unknown as Record<string, number>
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 1000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes acknowledgedAgentsByPaneKey entries older than the 7-day TTL during hydration', () => {
    // HYDRATE_MAX_AGE_MS lives in src/renderer/src/store/slices/ui.ts and matches
    // the constant in src/main/agent-hooks/server.ts.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-recent:0': now,
            'tab-old:1': now - SEVEN_DAYS_MS - 1
          }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-recent:0': now
      })
    } finally {
      // The shared afterEach restores mocks/globals but not timers, so clean up
      // here to avoid leaking fake timers into subsequent tests.
      vi.useRealTimers()
    }
  })

  it('drops prototype-pollution keys from acknowledgedAgentsByPaneKey during hydration', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      const malicious: Record<string, number> = {}
      // Object.defineProperty so these land as own enumerable properties rather
      // than getting silently re-routed to Object.prototype by the JS engine.
      Object.defineProperty(malicious, '__proto__', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'constructor', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'prototype', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      malicious['tab-safe:0'] = now

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: malicious
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-safe:0': now
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges and persists partial task resume updates', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.setState({ taskResumeState: { githubMode: 'project', linearPreset: 'all' } })
    store.getState().setTaskResumeState({ githubItemsPreset: 'my-prs' })

    const expected = { githubMode: 'project', linearPreset: 'all', githubItemsPreset: 'my-prs' }
    expect(store.getState().taskResumeState).toEqual(expected)
    expect(setUI).toHaveBeenCalledWith({ taskResumeState: expected })
  })

  it('keeps fixed card properties when toggling Agent activity', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.setState({ worktreeCardProperties: ['inline-agents'] })
    store.getState().toggleWorktreeCardProperty('inline-agents')

    const expected: WorktreeCardProperty[] = ['status', 'unread']
    expect(store.getState().worktreeCardProperties).toEqual(expected)
    expect(setUI).toHaveBeenCalledWith({ worktreeCardProperties: expected })
  })

  it('persists the agent activity display mode', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.getState().setAgentActivityDisplayMode('full')

    expect(store.getState().agentActivityDisplayMode).toBe('full')
    expect(setUI).toHaveBeenCalledWith({ agentActivityDisplayMode: 'full' })
  })

  it('normalizes invalid persisted agent activity display modes', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        agentActivityDisplayMode: 'bogus' as PersistedUIState['agentActivityDisplayMode']
      })
    )

    expect(store.getState().agentActivityDisplayMode).toBe('compact')
  })
})

describe('createUISlice settings navigation', () => {
  it('prefetches the restored default task source when provider settings drifted', () => {
    const store = createUIStore()
    const prefetchWorkItems = vi.fn()
    const prefetchLinearIssues = vi.fn()

    store.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/repo',
          displayName: 'Repo',
          badgeColor: 'blue',
          addedAt: 1,
          kind: 'git'
        }
      ],
      settings: {
        visibleTaskProviders: ['linear'],
        defaultTaskSource: 'github',
        defaultTaskViewPreset: 'all'
      } as unknown as AppState['settings'],
      linearStatus: { connected: true } as AppState['linearStatus'],
      preflightStatus: { glab: { installed: false } } as AppState['preflightStatus'],
      prefetchWorkItems,
      prefetchLinearIssues
    } as unknown as Partial<AppState>)

    store.getState().openTaskPage()

    expect(prefetchWorkItems).toHaveBeenCalledWith(
      'repo-1',
      '/repo',
      expect.any(Number),
      'is:issue is:open'
    )
    expect(prefetchLinearIssues).not.toHaveBeenCalled()
  })

  it('returns to the tasks page after visiting settings from an in-progress draft', () => {
    const store = createUIStore()

    store.getState().openTaskPage({ preselectedRepoId: 'repo-1' })
    store.getState().openSettingsPage()

    expect(store.getState().activeView).toBe('settings')
    expect(store.getState().previousViewBeforeSettings).toBe('tasks')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('tasks')
  })

  it('keeps the original return target when settings is reopened while already visible', () => {
    const store = createUIStore()

    store.getState().openTaskPage()
    store.getState().openSettingsPage()
    store.getState().openSettingsPage()

    expect(store.getState().previousViewBeforeSettings).toBe('tasks')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('tasks')
  })

  it('clears transient settings search when opening settings', () => {
    const store = createUIStore()

    store.setState({ settingsSearchInputQuery: 'terminal', settingsSearchQuery: 'terminal' })
    store.getState().openSettingsPage()

    expect(store.getState().activeView).toBe('settings')
    expect(store.getState().settingsSearchInputQuery).toBe('')
    expect(store.getState().settingsSearchQuery).toBe('')
  })
})

describe('createUISlice new workspace draft', () => {
  it('preserves Linear linked work item metadata', () => {
    const store = createUIStore()

    store.getState().setNewWorkspaceDraft({
      repoId: 'repo-1',
      name: 'Fix launch context handoff',
      prompt: '',
      note: '',
      attachments: [],
      linkedWorkItem: {
        type: 'issue',
        number: 0,
        title: 'Fix launch context handoff',
        url: 'https://linear.app/acme/issue/ENG-123/fix-launch-context-handoff',
        linearIdentifier: 'ENG-123'
      },
      agent: 'claude',
      linkedIssue: '',
      linkedPR: null,
      linkedGitLabIssue: null,
      linkedGitLabMR: null
    })

    expect(store.getState().newWorkspaceDraft?.linkedWorkItem).toMatchObject({
      linearIdentifier: 'ENG-123'
    })
  })

  it('keeps older linked work item drafts without Linear context fields valid', () => {
    const store = createUIStore()

    store.getState().setNewWorkspaceDraft({
      repoId: 'repo-1',
      name: 'Legacy issue',
      prompt: '',
      note: '',
      attachments: [],
      linkedWorkItem: {
        type: 'issue',
        number: 42,
        title: 'Legacy issue',
        url: 'https://github.com/acme/repo/issues/42'
      },
      agent: 'claude',
      linkedIssue: '42',
      linkedPR: null,
      linkedGitLabIssue: null,
      linkedGitLabMR: null
    })

    expect(store.getState().newWorkspaceDraft?.linkedWorkItem).toEqual({
      type: 'issue',
      number: 42,
      title: 'Legacy issue',
      url: 'https://github.com/acme/repo/issues/42'
    })
  })
})

describe('createUISlice page navigation history', () => {
  it('records and rewinds Tasks visits on close', () => {
    const store = createUIStore()
    store.setState({ worktreesByRepo: { 'repo-1': [makeWorktree('a')] } })

    store.getState().recordWorktreeVisit('a')
    store.getState().openTaskPage()
    expect(store.getState().worktreeNavHistory).toEqual(['a', 'tasks'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)

    store.getState().closeTaskPage()
    expect(store.getState().activeView).toBe('terminal')
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('rewinds Tasks detail visits on close', () => {
    const store = createUIStore()
    const workItem = makeGitHubWorkItem()
    store.setState({ worktreesByRepo: { 'repo-1': [makeWorktree('a')] } })

    store.getState().recordWorktreeVisit('a')
    store.getState().openTaskPage({ taskSource: 'github', openGitHubWorkItem: workItem })
    expect(store.getState().worktreeNavHistory).toEqual([
      'a',
      'tasks',
      { kind: 'task-detail', source: 'github', workItem, initialTab: undefined }
    ])
    expect(store.getState().worktreeNavHistoryIndex).toBe(2)

    store.getState().closeTaskPage()
    expect(store.getState().activeView).toBe('terminal')
    expect(store.getState().taskPageData).toEqual({})
    expect(store.getState().githubTaskDrawerWorkItem).toBeNull()
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('records provider-depth interactions for direct Tasks detail opens', () => {
    const store = createUIStore()
    const recordFeatureInteraction = vi.fn()
    store.setState({ recordFeatureInteraction } as Partial<AppState>)
    const workItem = makeGitHubWorkItem()
    const linearIssue = makeLinearIssue()

    store.getState().openTaskPage({ taskSource: 'github', openGitHubWorkItem: workItem })
    store.getState().openTaskPage({ taskSource: 'linear', openLinearIssue: linearIssue })

    expect(recordFeatureInteraction).toHaveBeenCalledWith('tasks')
    expect(recordFeatureInteraction).toHaveBeenCalledWith('github-tasks')
    expect(recordFeatureInteraction).toHaveBeenCalledWith('linear-tasks')
  })

  it('can suppress the Tasks surface interaction for in-page provider navigation', () => {
    const store = createUIStore()
    const recordFeatureInteraction = vi.fn()
    store.setState({ recordFeatureInteraction } as Partial<AppState>)
    const workItem = makeGitHubWorkItem()
    const linearIssue = makeLinearIssue()

    store
      .getState()
      .openTaskPage(
        { taskSource: 'github', openGitHubWorkItem: workItem },
        { recordTasksInteraction: false }
      )
    store
      .getState()
      .openTaskPage(
        { taskSource: 'linear', openLinearIssue: linearIssue },
        { recordTasksInteraction: false }
      )

    expect(recordFeatureInteraction).not.toHaveBeenCalledWith('tasks')
    expect(recordFeatureInteraction).toHaveBeenCalledWith('github-tasks')
    expect(recordFeatureInteraction).toHaveBeenCalledWith('linear-tasks')
  })

  it('skips the whole Tasks detail stack on close', () => {
    const store = createUIStore()
    const workItem = makeGitHubWorkItem()
    store.setState({ worktreesByRepo: { 'repo-1': [makeWorktree('a')] } })

    store.getState().recordWorktreeVisit('a')
    store.getState().openTaskPage({ taskSource: 'github', openGitHubWorkItem: workItem })
    store.getState().openTaskPage({ taskSource: 'linear' })
    expect(store.getState().worktreeNavHistory).toEqual([
      'a',
      'tasks',
      { kind: 'task-detail', source: 'github', workItem, initialTab: undefined },
      'tasks'
    ])

    store.getState().closeTaskPage()
    expect(store.getState().activeView).toBe('terminal')
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('records and rewinds Automations visits on close', () => {
    const store = createUIStore()
    store.setState({ worktreesByRepo: { 'repo-1': [makeWorktree('a')] } })

    store.getState().recordWorktreeVisit('a')
    store.getState().openAutomationsPage()
    expect(store.getState().worktreeNavHistory).toEqual(['a', 'automations'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)

    store.getState().closeAutomationsPage()
    expect(store.getState().activeView).toBe('terminal')
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('dedupes repeated Automations opens against the current history entry', () => {
    const store = createUIStore()
    store.setState({ worktreesByRepo: { 'repo-1': [makeWorktree('a')] } })

    store.getState().recordWorktreeVisit('a')
    store.getState().openAutomationsPage()
    store.getState().openAutomationsPage()

    expect(store.getState().activeView).toBe('automations')
    expect(store.getState().worktreeNavHistory).toEqual(['a', 'automations'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(1)
  })

  it('keeps the Automations history index when Automations is the only entry', () => {
    const store = createUIStore()

    store.getState().openAutomationsPage()
    expect(store.getState().worktreeNavHistory).toEqual(['automations'])
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)

    store.getState().closeAutomationsPage()
    expect(store.getState().activeView).toBe('terminal')
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })

  it('skips deleted prior worktrees when closing Automations', () => {
    const store = createUIStore()
    store.setState({
      activeView: 'automations',
      previousViewBeforeAutomations: 'terminal',
      worktreesByRepo: { 'repo-1': [makeWorktree('c')] },
      worktreeNavHistory: ['c', 'a', 'automations'],
      worktreeNavHistoryIndex: 2
    })

    store.getState().closeAutomationsPage()
    expect(store.getState().activeView).toBe('terminal')
    expect(store.getState().worktreeNavHistoryIndex).toBe(0)
  })
})

describe('createUISlice feature tips', () => {
  it('marks feature tips seen and persists them once', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().markFeatureTipsSeen(['voice-dictation'])
    store.getState().markFeatureTipsSeen(['voice-dictation'])

    expect(store.getState().featureTipsSeenIds).toEqual(['voice-dictation'])
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ featureTipsSeenIds: ['voice-dictation'] })
  })

  it('normalizes persisted feature tip ids during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        featureTipsSeenIds: ['voice-dictation', 'unknown', 'voice-dictation'] as never
      })
    )

    expect(store.getState().featureTipsSeenIds).toEqual(['voice-dictation'])
  })
})

describe('createUISlice setup guide sidebar dismissal', () => {
  it('persists sidebar dismissal changes once', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().setSetupGuideSidebarDismissed(true)
    store.getState().setSetupGuideSidebarDismissed(true)

    expect(store.getState().setupGuideSidebarDismissed).toBe(true)
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ setupGuideSidebarDismissed: true })
  })

  it('hydrates only explicit sidebar dismissals as hidden', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ setupGuideSidebarDismissed: true }))
    expect(store.getState().setupGuideSidebarDismissed).toBe(true)

    store.getState().hydratePersistedUI(makePersistedUI({ setupGuideSidebarDismissed: undefined }))
    expect(store.getState().setupGuideSidebarDismissed).toBe(false)
  })

  it('persists browser milestone migration result once', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().markSetupGuideBrowserMilestoneMigrated(true)
    store.getState().markSetupGuideBrowserMilestoneMigrated(true)

    expect(store.getState().setupGuideBrowserMilestoneMigrated).toBe(true)
    expect(store.getState().setupGuideBrowserMilestoneLegacyComplete).toBe(true)
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({
      setupGuideBrowserMilestoneMigrated: true,
      setupGuideBrowserMilestoneLegacyComplete: true
    })
  })

  it('hydrates browser milestone migration fields explicitly', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        setupGuideBrowserMilestoneMigrated: true,
        setupGuideBrowserMilestoneLegacyComplete: true
      })
    )
    expect(store.getState().setupGuideBrowserMilestoneMigrated).toBe(true)
    expect(store.getState().setupGuideBrowserMilestoneLegacyComplete).toBe(true)

    store.getState().hydratePersistedUI(
      makePersistedUI({
        setupGuideBrowserMilestoneMigrated: undefined,
        setupGuideBrowserMilestoneLegacyComplete: undefined
      })
    )
    expect(store.getState().setupGuideBrowserMilestoneMigrated).toBe(false)
    expect(store.getState().setupGuideBrowserMilestoneLegacyComplete).toBe(false)
  })
})

describe('createUISlice browser import hint dismissal', () => {
  it('persists browser import hint dismissal changes once', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().setBrowserImportHintHidden(true)
    store.getState().setBrowserImportHintHidden(true)

    expect(store.getState().browserImportHintHidden).toBe(true)
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ browserImportHintHidden: true })
  })

  it('hydrates only explicit browser import hint dismissals as hidden', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI({ browserImportHintHidden: true }))
    expect(store.getState().browserImportHintHidden).toBe(true)

    store.getState().hydratePersistedUI(makePersistedUI({ browserImportHintHidden: undefined }))
    expect(store.getState().browserImportHintHidden).toBe(false)
  })
})

describe('createUISlice feature interactions', () => {
  it('normalizes persisted feature interaction records during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100 },
          automations: { firstInteractedAt: 150, interactionCount: 4 },
          browser: { firstInteractedAt: Number.NaN },
          unknown: { firstInteractedAt: 200 }
        } as unknown as FeatureInteractionState
      })
    )

    expect(store.getState().featureInteractions).toEqual({
      tasks: { firstInteractedAt: 100, interactionCount: 1 },
      automations: { firstInteractedAt: 150, interactionCount: 4 }
    })
  })

  it('records feature interaction counts and persists each interaction', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      store.getState().hydratePersistedUI(makePersistedUI())
      setMock.mockClear()

      store.getState().recordFeatureInteraction('tasks')
      store.getState().recordFeatureInteraction('tasks')

      const expected: FeatureInteractionState = {
        tasks: { firstInteractedAt: now, interactionCount: 2 }
      }
      expect(store.getState().featureInteractions).toEqual(expected)
      expect(setMock).toHaveBeenCalledTimes(2)
      expect(setMock).toHaveBeenCalledWith({ featureInteractions: expected })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the main-owned feature interaction increment API when available', async () => {
    const recordFeatureInteractionMock = vi.fn(() =>
      Promise.resolve(
        makePersistedUI({
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 3 }
          },
          contextualToursSeenIds: ['browser']
        })
      )
    )
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          recordFeatureInteraction: recordFeatureInteractionMock,
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.getState().hydratePersistedUI(
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 2 }
        },
        contextualToursSeenIds: ['tasks']
      })
    )
    setMock.mockClear()

    store.getState().recordFeatureInteraction('tasks')
    await Promise.resolve()

    expect(recordFeatureInteractionMock).toHaveBeenCalledWith('tasks')
    expect(setMock).not.toHaveBeenCalled()
    expect(store.getState().featureInteractions.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 3
    })
    expect(store.getState().contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('keeps newer optimistic interaction counts when persistence responses resolve out of order', async () => {
    const pending: ((ui: PersistedUIState) => void)[] = []
    const recordFeatureInteractionMock = vi.fn(
      () =>
        new Promise<PersistedUIState>((resolve) => {
          pending.push(resolve)
        })
    )
    vi.stubGlobal('window', {
      api: {
        ui: {
          recordFeatureInteraction: recordFeatureInteractionMock,
          set: vi.fn(() => Promise.resolve())
        }
      }
    })
    const store = createUIStore()
    store.getState().hydratePersistedUI(makePersistedUI())

    store.getState().recordFeatureInteraction('tasks')
    store.getState().recordFeatureInteraction('tasks')

    pending[1](
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 2 }
        }
      })
    )
    await Promise.resolve()
    pending[0](
      makePersistedUI({
        featureInteractions: {
          tasks: { firstInteractedAt: 100, interactionCount: 1 }
        }
      })
    )
    await Promise.resolve()

    expect(store.getState().featureInteractions.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 2
    })
  })

  it('does not record interactions before persisted UI has hydrated', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().recordFeatureInteraction('tasks')

    expect(store.getState().featureInteractions).toEqual({})
    expect(setMock).not.toHaveBeenCalled()
  })
})

function stubContextualTourTargets(selectors: readonly string[]): void {
  const selectorSet = new Set(selectors)
  vi.stubGlobal('document', {
    querySelector: vi.fn((selector: string) =>
      selectorSet.has(selector)
        ? {
            getBoundingClientRect: () => ({
              left: 10,
              top: 10,
              right: 110,
              bottom: 50,
              width: 100,
              height: 40
            })
          }
        : null
    )
  })
}

describe('createUISlice contextual tours', () => {
  function makeAutoTourEligibleUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
    return makePersistedUI({
      contextualToursAutoEligible: true,
      ...overrides
    })
  }

  it('normalizes persisted contextual tour ids during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        contextualToursSeenIds: ['tasks', 'unknown', 'tasks', 'browser'] as never
      })
    )

    expect(store.getState().contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('normalizes persisted contextual tour auto eligibility during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI())
    expect(store.getState().contextualToursAutoEligible).toBeNull()

    store.getState().hydratePersistedUI(makePersistedUI({ contextualToursAutoEligible: false }))
    expect(store.getState().contextualToursAutoEligible).toBe(false)

    store
      .getState()
      .hydratePersistedUI(makePersistedUI({ contextualToursAutoEligible: 'yes' as never }))
    expect(store.getState().contextualToursAutoEligible).toBeNull()
  })

  it('persists contextual tour auto eligibility once classified', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().setContextualToursAutoEligible(false)
    store.getState().setContextualToursAutoEligible(false)

    expect(store.getState().contextualToursAutoEligible).toBe(false)
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ contextualToursAutoEligible: false })
  })

  it('marks contextual tours seen and persists them once', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()

    store.getState().markContextualToursSeen(['tasks'])
    store.getState().markContextualToursSeen(['tasks'])

    expect(store.getState().contextualToursSeenIds).toEqual(['tasks'])
    expect(setMock).toHaveBeenCalledTimes(1)
    expect(setMock).toHaveBeenCalledWith({ contextualToursSeenIds: ['tasks'] })
  })

  it('starts a tour only after persisted UI and required first target are ready', () => {
    const store = createUIStore()
    const tasksFirstSelector = '[data-contextual-tour-target="tasks-source-filters"]'
    stubContextualTourTargets([tasksFirstSelector])

    store.getState().requestContextualTour('tasks', 'tasks_open')
    expect(store.getState().activeContextualTourId).toBeNull()

    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBe('tasks')
    expect(store.getState().activeContextualTourStepIndex).toBe(0)
    expect(store.getState().activeContextualTourSource).toBe('tasks_open')
    expect(store.getState().contextualTourShownThisSession).toBe(true)
    expect(store.getState().contextualToursSeenIds).toEqual([])
  })

  it('stores whether the feature was interacted with before the tour request', () => {
    const store = createUIStore()
    const tasksFirstSelector = '[data-contextual-tour-target="tasks-source-filters"]'
    stubContextualTourTargets([tasksFirstSelector])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().recordFeatureInteraction('tasks')
    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(true)
  })

  it('lets the caller preserve the pre-enable interaction snapshot for telemetry', () => {
    const store = createUIStore()
    const tasksFirstSelector = '[data-contextual-tour-target="tasks-source-filters"]'
    stubContextualTourTargets([tasksFirstSelector])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().recordFeatureInteraction('tasks')
    store.getState().requestContextualTour('tasks', 'tasks_open', false)

    expect(store.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)
  })

  it('does not bias first-visit contextual tour telemetry from navigation actions', () => {
    stubContextualTourTargets([
      '[data-contextual-tour-target="tasks-source-filters"]',
      '[data-contextual-tour-target="automations-create"]',
      '[data-contextual-tour-target="workspace-creation-project"]'
    ])

    const tasksStore = createUIStore()
    tasksStore.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    tasksStore.getState().openTaskPage()
    tasksStore.getState().requestContextualTour('tasks', 'tasks_open')
    expect(tasksStore.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)

    const automationsStore = createUIStore()
    automationsStore.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    automationsStore.getState().openAutomationsPage()
    automationsStore.getState().requestContextualTour('automations', 'automations_open')
    expect(automationsStore.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(
      false
    )

    const composerStore = createUIStore()
    composerStore.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    composerStore.getState().openModal('new-workspace-composer')
    composerStore.getState().requestContextualTour('workspace-creation', 'workspace_creation_modal')
    expect(composerStore.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)
  })

  it('does not mark seen when the required first target is absent', () => {
    const store = createUIStore()
    stubContextualTourTargets([])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(store.getState().contextualTourShownThisSession).toBe(false)
  })

  it('does not start while a root confirmation surface is visible', () => {
    const store = createUIStore()
    stubContextualTourTargets(['[data-contextual-tour-target="tasks-source-filters"]'])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().setContextualToursBlockingSurfaceVisible(true)
    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(false)
  })

  it('does not auto-start tours for profiles that are not eligible', () => {
    const store = createUIStore()
    stubContextualTourTargets(['[data-contextual-tour-target="tasks-source-filters"]'])
    store.getState().hydratePersistedUI(makePersistedUI({ contextualToursAutoEligible: false }))

    store.getState().requestContextualTour('tasks', 'tasks_open')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(false)
  })

  it('force-starts a tour from an explicit user action even after auto tours are unavailable', () => {
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]'
    ])
    store.getState().hydratePersistedUI(
      makePersistedUI({
        contextualToursAutoEligible: false,
        contextualToursSeenIds: ['workspace-agent-sessions']
      })
    )

    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourSource).toBe('setup_guide_parallel_work')
    expect(store.getState().activeContextualTourWasFeaturePreviouslyInteracted).toBe(false)
  })

  it('preserves the bounded setup-guide parallel-work source on forced tour requests', () => {
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]'
    ])
    store.getState().hydratePersistedUI(
      makePersistedUI({
        contextualToursAutoEligible: false,
        contextualToursSeenIds: ['workspace-agent-sessions']
      })
    )

    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourSource).toBe('setup_guide_parallel_work')
  })

  it('allows only workspace creation over its workspace composer modal', () => {
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="tasks-source-filters"]',
      '[data-contextual-tour-target="workspace-creation-project"]'
    ])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())

    store.getState().openModal('new-workspace-composer')
    store.getState().requestContextualTour('tasks', 'tasks_open')
    expect(store.getState().activeContextualTourId).toBeNull()

    store.getState().requestContextualTour('workspace-creation', 'workspace_creation_modal')
    expect(store.getState().activeContextualTourId).toBe('workspace-creation')
  })

  it('advances across visible steps and leaves completion to the overlay', () => {
    const store = createUIStore()
    const visibleSelectors = [
      '[data-contextual-tour-target="browser-grab-control"]',
      '[data-contextual-tour-target="browser-annotation-control"]',
      '[data-contextual-tour-target="browser-import-cookies-control"]'
    ]
    stubContextualTourTargets(visibleSelectors)
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store.getState().requestContextualTour('browser', 'browser_visible')

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourStepIndex).toBe(1)

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourId).toBe('browser')
    expect(store.getState().activeContextualTourStepIndex).toBe(2)
  })

  it('advances the browser tour to the cookie step before Import Cookies is measurable', () => {
    const store = createUIStore()
    const visibleSelectors = [
      '[data-contextual-tour-target="browser-grab-control"]',
      '[data-contextual-tour-target="browser-annotation-control"]'
    ]
    stubContextualTourTargets(visibleSelectors)
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store.getState().requestContextualTour('browser', 'browser_visible')

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourStepIndex).toBe(1)

    store.getState().advanceContextualTour()
    expect(store.getState().activeContextualTourStepIndex).toBe(2)
  })

  it('advances the active split step when the split command interaction is recorded', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]',
      '[data-contextual-tour-target="workspace-create-control"]'
    ])
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    setMock.mockClear()
    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    store.getState().recordFeatureInteraction('terminal-pane-split')

    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourStepIndex).toBe(1)
    expect(store.getState().featureInteractions['terminal-pane-split']).toMatchObject({
      interactionCount: 1
    })
  })

  it('opens the sidebar and advances the split step when the create-worktree target is hidden', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    stubContextualTourTargets([
      '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="workspace-agent-terminal-tip"]'
    ])
    store.setState({ sidebarOpen: false })
    store.getState().hydratePersistedUI(makeAutoTourEligibleUI())
    store
      .getState()
      .requestContextualTour('workspace-agent-sessions', 'setup_guide_parallel_work', false, {
        force: true
      })

    store.getState().recordFeatureInteraction('terminal-pane-split')

    expect(store.getState().sidebarOpen).toBe(true)
    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
    expect(store.getState().activeContextualTourStepIndex).toBe(1)
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(store.getState().lastCompletedContextualTourId).toBeNull()
  })

  it('marks the active contextual tour suppressed when its owning source disables', () => {
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'browser',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'browser_visible',
      activeContextualTourWasFeaturePreviouslyInteracted: false,
      contextualTourShownThisSession: true
    })

    store.getState().suppressContextualTour('tasks', 'tasks_open')
    expect(store.getState().activeContextualTourSuppressed).toBe(false)

    store.getState().suppressContextualTour('browser', 'browser_visible')
    expect(store.getState().activeContextualTourSuppressed).toBe(true)
  })

  it('keeps an intentionally detached contextual tour active when its owning source disables', () => {
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 3,
      activeContextualTourSource: 'workspace_agent_sessions_visible',
      activeContextualTourWasFeaturePreviouslyInteracted: false,
      contextualTourShownThisSession: true
    })

    store
      .getState()
      .detachContextualTourSource('workspace-agent-sessions', 'workspace_agent_sessions_visible')
    store
      .getState()
      .suppressContextualTour('workspace-agent-sessions', 'workspace_agent_sessions_visible')

    expect(store.getState().activeContextualTourSourceDetached).toBe(true)
    expect(store.getState().activeContextualTourSuppressed).toBe(false)
    expect(store.getState().activeContextualTourId).toBe('workspace-agent-sessions')
  })

  it('cancels a not-yet-rendered tour without persistence churn', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'tasks',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'tasks_open',
      contextualTourShownThisSession: true
    })

    store.getState().cancelContextualTour('tasks')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(false)
    expect(store.getState().lastCompletedContextualTourId).toBeNull()
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(setMock).not.toHaveBeenCalled()
  })

  it('preserves the session guard when canceling an already-rendered tour', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'tasks',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'tasks_open',
      contextualTourShownThisSession: true,
      contextualToursSeenIds: ['tasks']
    })

    store.getState().cancelContextualTour('tasks')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualTourShownThisSession).toBe(true)
    expect(store.getState().contextualToursSeenIds).toEqual<ContextualTourId[]>(['tasks'])
    expect(setMock).not.toHaveBeenCalled()
  })

  it('dismisses active tours as seen', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'automations',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'automations_open',
      contextualTourShownThisSession: true
    })

    store.getState().dismissContextualTour('automations')

    expect(store.getState().activeContextualTourId).toBeNull()
    expect(store.getState().contextualToursSeenIds).toEqual<ContextualTourId[]>(['automations'])
    expect(store.getState().lastCompletedContextualTourId).toBeNull()
    expect(setMock).toHaveBeenCalledWith({ contextualToursSeenIds: ['automations'] })
  })

  it('ignores stale dismissals for a different active tour', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const store = createUIStore()
    store.setState({
      activeContextualTourId: 'tasks',
      activeContextualTourStepIndex: 0,
      activeContextualTourSource: 'tasks_open',
      contextualTourShownThisSession: true
    })

    store.getState().dismissContextualTour('browser')

    expect(store.getState().activeContextualTourId).toBe('tasks')
    expect(store.getState().contextualToursSeenIds).toEqual([])
    expect(setMock).not.toHaveBeenCalled()
  })
})

describe('createUISlice space navigation', () => {
  it('records Space page opens as workspace cleanup interactions', () => {
    const setMock = vi.fn(() => Promise.resolve())
    vi.stubGlobal('window', {
      api: {
        ui: {
          set: setMock
        }
      }
    })
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      store.getState().hydratePersistedUI(makePersistedUI())
      setMock.mockClear()

      store.getState().openSpacePage()

      const expected: FeatureInteractionState = {
        'workspace-cleanup': { firstInteractedAt: now, interactionCount: 1 }
      }
      expect(store.getState().featureInteractions).toEqual(expected)
      expect(setMock).toHaveBeenCalledWith({ featureInteractions: expected })
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to the tasks page after opening Space from an in-progress draft', () => {
    const store = createUIStore()

    store.getState().openTaskPage({ preselectedRepoId: 'repo-1' })
    store.getState().openSpacePage()

    expect(store.getState().activeView).toBe('space')
    expect(store.getState().previousViewBeforeSpace).toBe('tasks')

    store.getState().closeSpacePage()

    expect(store.getState().activeView).toBe('tasks')
  })

  it('keeps the original return target when Space is reopened while already visible', () => {
    const store = createUIStore()

    store.getState().openTaskPage()
    store.getState().openSpacePage()
    store.getState().openSpacePage()

    expect(store.getState().previousViewBeforeSpace).toBe('tasks')

    store.getState().closeSpacePage()

    expect(store.getState().activeView).toBe('tasks')
  })
})
