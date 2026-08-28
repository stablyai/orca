import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import type { AppState } from '../types'
import { createUIStore } from './ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/active-agent-note-send', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status),
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
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
  mocks.sendNotesToActiveAgentSession.mockReset()
  mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

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
      ptyIdsByTabId: {
        [tabId]: ['pty-ready', 'pty-working']
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
      eligiblePaneKeys: [readyPaneKey, workingPaneKey],
      disabledPaneKeys: {},
      status: 'open'
    })
    expect(store.getState().pendingRevealWorktree).toMatchObject({
      worktreeId,
      behavior: 'auto',
      highlight: true
    })
  })

  it('disables sidebar target rows that need permission', async () => {
    const store = createUIStore()
    seedAgentSendState(store)
    const agentStatusByPaneKey = store.getState().agentStatusByPaneKey
    store.setState({
      agentStatusByPaneKey: {
        ...agentStatusByPaneKey,
        [workingPaneKey]: {
          ...agentStatusByPaneKey[workingPaneKey]!,
          state: 'blocked'
        }
      }
    } as Partial<AppState>)

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
        [workingPaneKey]: 'Agent needs permission'
      },
      status: 'open'
    })
    await expect(store.getState().sendPromptToSidebarAgentTarget(workingPaneKey)).resolves.toBe(
      false
    )
    expect(mocks.sendNotesToActiveAgentSession).not.toHaveBeenCalled()
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
          ptyIdsByLeafId: {
            [readyLeafId]: 'pty-ready',
            [workingLeafId]: 'pty-working'
          }
        }
      },
      ptyIdsByTabId: {
        [tabId]: []
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

    expect(mocks.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId,
      prompt: 'Review this',
      noteTarget: { tabId, leafId: readyLeafId }
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
    mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'not-ready' })
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
      description: 'selected:not-ready'
    })
    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      status: 'error',
      error: 'selected:not-ready'
    })
  })

  it('sends to a working agent row through the selected-target note helper', async () => {
    const store = createUIStore()
    seedAgentSendState(store)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'browser-annotations',
      prompt: 'Review this',
      label: 'Browser annotations',
      launchSource: 'notes_send'
    })

    await expect(store.getState().sendPromptToSidebarAgentTarget(workingPaneKey)).resolves.toBe(
      true
    )

    expect(mocks.sendNotesToActiveAgentSession).toHaveBeenCalledWith({
      worktreeId,
      prompt: 'Review this',
      noteTarget: { tabId, leafId: workingLeafId }
    })
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Sent to Codex')
    expect(store.getState().agentSendPopoverTargetMode).toBeNull()
  })

  it('does not let an older send close a reopened popover with the same id', async () => {
    const store = createUIStore()
    const onPromptDelivered = vi.fn()
    const write = deferred<{ status: 'sent' }>()
    seedAgentSendState(store)
    mocks.sendNotesToActiveAgentSession.mockReturnValue(write.promise)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this',
      label: 'All unsent notes',
      launchSource: 'notes_send',
      onPromptDelivered
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

    write.resolve({ status: 'sent' })
    await expect(send).resolves.toBe(false)

    expect(store.getState().agentSendPopoverTargetMode).toBe(reopenedMode)
    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      prompt: 'Review this again',
      status: 'open'
    })
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does not let an older send failure mutate a reopened popover with the same id', async () => {
    const store = createUIStore()
    const onPromptDelivered = vi.fn()
    const write = deferred<{ status: 'not-ready' }>()
    seedAgentSendState(store)
    mocks.sendNotesToActiveAgentSession.mockReturnValue(write.promise)
    store.getState().openAgentSendPopoverTargetMode({
      id: 'send-1',
      worktreeId,
      source: 'diff-notes',
      prompt: 'Review this',
      label: 'All unsent notes',
      launchSource: 'notes_send',
      onPromptDelivered
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

    write.resolve({ status: 'not-ready' })
    await expect(send).resolves.toBe(false)

    expect(store.getState().agentSendPopoverTargetMode).toBe(reopenedMode)
    expect(store.getState().agentSendPopoverTargetMode).toMatchObject({
      id: 'send-1',
      prompt: 'Review this again',
      status: 'open'
    })
    expect(onPromptDelivered).not.toHaveBeenCalled()
    expect(mocks.track).not.toHaveBeenCalled()
    expect(mocks.toastSuccess).not.toHaveBeenCalled()
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('does not retarget the same popover while a send is in progress', async () => {
    const store = createUIStore()
    const write = deferred<{ status: 'sent' }>()
    seedAgentSendState(store)
    mocks.sendNotesToActiveAgentSession.mockReturnValue(write.promise)
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

    write.resolve({ status: 'sent' })
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

describe('openDiffNotesSendMenuForActiveWorktree', () => {
  function stubDiffNotesStore(
    comments: { sentAt?: number }[],
    activeWorktreeId: string | null = 'wt-1'
  ): { store: StoreApi<AppState>; setRightSidebarTab: ReturnType<typeof vi.fn> } {
    const store = createUIStore()
    const setRightSidebarTab = vi.fn()
    store.setState({
      activeWorktreeId,
      getDiffComments: () => comments,
      setRightSidebarTab,
      setRightSidebarOpen: vi.fn()
    } as unknown as Partial<AppState>)
    return { store, setRightSidebarTab }
  }

  it('reveals Source Control and bumps the open request when unsent notes exist', () => {
    const { store, setRightSidebarTab } = stubDiffNotesStore([{ sentAt: 10 }, {}])

    expect(store.getState().openDiffNotesSendMenuForActiveWorktree()).toBe(true)
    expect(setRightSidebarTab).toHaveBeenCalledWith('source-control')
    expect(store.getState().diffNotesSendMenuOpenRequest).toMatchObject({
      worktreeId: 'wt-1',
      nonce: 1
    })
    expect(store.getState().diffNotesSendMenuOpenRequest?.issuedAt).toBeTypeOf('number')

    // A second request increments the nonce so the menu reopens.
    expect(store.getState().openDiffNotesSendMenuForActiveWorktree()).toBe(true)
    expect(store.getState().diffNotesSendMenuOpenRequest).toMatchObject({
      worktreeId: 'wt-1',
      nonce: 2
    })
  })

  it('is a no-op when every note is already sent', () => {
    const { store, setRightSidebarTab } = stubDiffNotesStore([{ sentAt: 10 }])

    expect(store.getState().openDiffNotesSendMenuForActiveWorktree()).toBe(false)
    expect(setRightSidebarTab).not.toHaveBeenCalled()
    expect(store.getState().diffNotesSendMenuOpenRequest).toBeNull()
  })

  it('is a no-op when there is no active worktree', () => {
    const { store } = stubDiffNotesStore([{}], null)

    expect(store.getState().openDiffNotesSendMenuForActiveWorktree()).toBe(false)
    expect(store.getState().diffNotesSendMenuOpenRequest).toBeNull()
  })

  it('clears the request only for the matching worktree', () => {
    const { store } = stubDiffNotesStore([{}])
    store.getState().openDiffNotesSendMenuForActiveWorktree()

    store.getState().consumeDiffNotesSendMenuOpenRequest('other-wt')
    expect(store.getState().diffNotesSendMenuOpenRequest).not.toBeNull()

    store.getState().consumeDiffNotesSendMenuOpenRequest('wt-1')
    expect(store.getState().diffNotesSendMenuOpenRequest).toBeNull()
  })
})
