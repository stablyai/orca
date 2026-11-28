// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionContinuationRequest } from '../../../../../../shared/agent-session/conversation-context/agent-session-continuation'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { useNativeChatHandOff } from './use-native-chat-hand-off'

const toastError = vi.fn()
const callStructuredAgentSession = vi.fn()
const supportsContinuation = vi.fn()
let lastDialogRequest: AgentSessionContinuationRequest | null = null

vi.mock('sonner', () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args)
  }
}))

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: { unifiedTabsByWorktree: Record<string, never[]> }) => unknown) =>
    selector({ unifiedTabsByWorktree: {} })
}))

vi.mock('@/runtime/native-chat/naming/structured-conversation-name', () => ({
  useStructuredChatTabConversationName: () => 'Antigravity chat'
}))

vi.mock('@/runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: (...args: unknown[]) => callStructuredAgentSession(...args)
}))

vi.mock('@/runtime/native-chat/host-capabilities/structured-agent-session-host-support', () => ({
  supportsStructuredAgentSessionContinuationContext: (...args: unknown[]) =>
    supportsContinuation(...args)
}))

vi.mock('@/components/agent-session-continuation/AgentSessionContinuationDialog', () => ({
  AgentSessionContinuationDialog: ({
    open,
    request
  }: {
    open: boolean
    request: AgentSessionContinuationRequest | null
  }) => {
    lastDialogRequest = open ? request : null
    return open ? (
      <div data-testid="handoff-dialog">{request?.source.capturedText ?? ''}</div>
    ) : null
  }
}))

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  sequence: number
): NativeChatMessage {
  return {
    id,
    role,
    source: 'transcript',
    timestamp: 1_700_000_000_000 + sequence,
    journalPosition: { sequence, index: 0 },
    blocks: [{ type: 'text', text }]
  }
}

describe('useNativeChatHandOff.openFromResponse', () => {
  beforeEach(() => {
    toastError.mockReset()
    callStructuredAgentSession.mockReset()
    supportsContinuation.mockReset()
    lastDialogRequest = null
  })
  afterEach(() => {
    cleanup()
  })

  it('opens the hand-off dialog sliced through the chosen response without fetching the full transcript', () => {
    const messages = [
      message('u1', 'user', 'First question', 1),
      message('a1', 'assistant', 'Good answer', 2),
      message('u2', 'user', 'Derailed question', 3),
      message('a2', 'assistant', 'Unwanted answer', 4)
    ]
    let captured: ReturnType<typeof useNativeChatHandOff> | null = null
    function Harness({ list }: { list: readonly NativeChatMessage[] }) {
      captured = useNativeChatHandOff(
        {
          tabId: 'tab-1',
          groupId: 'grp-1',
          sessionId: 'sess-1',
          target: { kind: 'local' },
          agent: 'antigravity',
          isVisible: true
        },
        {
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          runtimeEnvironmentId: null
        },
        { messages: list, epoch: 'e1' },
        vi.fn()
      )
      return <>{captured.dialog}</>
    }

    const { rerender } = render(<Harness list={messages} />)
    const initialRowAction = captured!.rowSurface?.rowAction
    expect(initialRowAction).toBeDefined()

    // Updating messages keeps rowAction referentially stable so unchanged rows do not rerender.
    rerender(<Harness list={[...messages]} />)
    expect(captured!.rowSurface?.rowAction).toBe(initialRowAction)

    act(() => {
      captured!.openFromResponse('a1')
    })

    expect(callStructuredAgentSession).not.toHaveBeenCalled()
    expect(supportsContinuation).not.toHaveBeenCalled()
    expect(screen.getByTestId('handoff-dialog')).toBeTruthy()
    expect(lastDialogRequest?.source.truncatedToResponse).toBe(true)
    expect(lastDialogRequest?.source.transcriptPath).toBeUndefined()
    expect(lastDialogRequest?.source.capturedText).toContain('Good answer')
    expect(lastDialogRequest?.source.capturedText).not.toContain('Derailed question')
    expect(lastDialogRequest?.source.capturedText).not.toContain('Unwanted answer')
  })

  it('shows the noContext error toast when the target response is missing', () => {
    const focusComposer = vi.fn()
    let captured: ReturnType<typeof useNativeChatHandOff> | null = null
    function Harness() {
      captured = useNativeChatHandOff(
        {
          tabId: 'tab-1',
          groupId: 'grp-1',
          sessionId: 'sess-1',
          target: { kind: 'local' },
          agent: 'antigravity',
          isVisible: true
        },
        {
          worktreeId: 'wt-1',
          worktreePath: '/repo',
          runtimeEnvironmentId: null
        },
        { messages: [message('u1', 'user', 'Only user', 1)], epoch: 'e1' },
        focusComposer
      )
      return <>{captured.dialog}</>
    }

    render(<Harness />)
    act(() => {
      captured!.openFromResponse('missing-id')
    })

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(focusComposer).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId('handoff-dialog')).toBeNull()
  })
})
