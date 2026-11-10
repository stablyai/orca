import type { StoreApi } from 'zustand/vanilla'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import '../../../../../shared/agent-session/view/structured-agent-session-projection'
import '../../../../../shared/agent-notification-id'
import type { AppState } from '../../types'
import { createUIStore } from './ui-slice-test-harness'

const mocks = vi.hoisted(() => ({
  sendNotesToActiveAgentSession: vi.fn(),
  sendStructuredAgentSessionMessage: vi.fn(),
  relaunchFailedStructuredAgentSessionWithMessage: vi.fn(
    (): Promise<{ delivered: boolean }> | null => null
  ),
  track: vi.fn(),
  toastMessage: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/lib/agent-session/messaging/terminal/active-agent-note-send', () => ({
  sendNotesToActiveAgentSession: mocks.sendNotesToActiveAgentSession
}))
vi.mock('@/lib/agent-session/messaging/terminal/active-agent-note-send-result', () => ({
  activeAgentNotesSendFailureMessage: (
    status: string,
    options: { explicitTarget?: boolean } = {}
  ) => (options.explicitTarget ? `selected:${status}` : status)
}))

vi.mock(
  '@/components/native-chat/session/structured/delivery/structured-agent-session-message-sender',
  () => ({
    sendStructuredAgentSessionMessage: mocks.sendStructuredAgentSessionMessage
  })
)
// The chat's tab names its host; the send only needs to find one.
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => ({
      unifiedTabsByWorktree: {
        'wt-1': [{ contentType: 'agent-session', entityId: 'claude_1', worktreeId: 'wt-1' }]
      }
    })
  }
}))
vi.mock('@/runtime/native-chat/session-ownership/structured-agent-session-owner', () => ({
  structuredAgentSessionTargetForTab: () => ({ kind: 'local' })
}))

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-message', () => ({
  relaunchFailedStructuredAgentSessionWithMessage:
    mocks.relaunchFailedStructuredAgentSessionWithMessage
}))

vi.mock('@/diagnostics/telemetry/telemetry', () => ({
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
  vi.spyOn(Date, 'now').mockReturnValue(1_780_358_400_000)
  mocks.sendNotesToActiveAgentSession.mockReset()
  mocks.sendNotesToActiveAgentSession.mockResolvedValue({ status: 'sent' })
  mocks.sendStructuredAgentSessionMessage.mockReset()
  mocks.sendStructuredAgentSessionMessage.mockReturnValue({
    clientMessageId: 'sent',
    outcome: Promise.resolve('recorded')
  })
  mocks.relaunchFailedStructuredAgentSessionWithMessage.mockClear()
  mocks.track.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastSuccess.mockReset()
  mocks.toastError.mockReset()
})

// Why: send targets list structured chats from the tabs slice, which the UI harness omits.
function createAgentSendStore(): StoreApi<AppState> {
  const store = createUIStore()
  store.setState({ unifiedTabsByWorktree: {} })
  return store
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
    } satisfies Partial<AppState>)
  }

  it('does not retarget the same popover while a send is in progress', async () => {
    const store = createAgentSendStore()
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
