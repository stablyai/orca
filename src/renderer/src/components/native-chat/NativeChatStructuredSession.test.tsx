// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  fileLinkClick: vi.fn(),
  mode: 'static' as 'static' | 'outbox',
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
  },
  composerProps: null as null | { structuredTransport?: Record<string, unknown> }
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./use-structured-agent-session', async () => {
  const { useStructuredAgentSessionOutbox } = await import('./use-structured-agent-session-outbox')
  return {
    useStructuredAgentSession: (props: { sessionId: string; target: { kind: 'local' } }) => {
      const outbox = useStructuredAgentSessionOutbox({
        sessionId: props.sessionId,
        target: props.target,
        fence: 1,
        submissions: []
      })
      return {
        messages:
          mocks.mode === 'outbox'
            ? []
            : [
                {
                  id: 'message-1',
                  role: 'assistant',
                  source: 'transcript',
                  timestamp: 1,
                  blocks: [{ type: 'text', text: '[file](file:///repo/src/main.ts)' }]
                }
              ],
        status: 'ready' as const,
        error: outbox.error,
        hasOlder: false,
        loadingOlder: false,
        loadOlder: vi.fn(),
        prompts: [],
        outbox: outbox.outbox,
        blockedClientMessageId: outbox.blockedClientMessageId,
        send: outbox.send,
        retry: outbox.retry,
        isWorking: false,
        turnId: null,
        cancel: vi.fn(),
        respond: vi.fn(),
        optionSnapshot: [
          {
            id: 'model',
            label: 'Model',
            category: 'model',
            kind: {
              type: 'select',
              currentValue: 'gpt-live',
              choices: [{ value: 'gpt-live', label: 'GPT Live' }]
            },
            valueSource: 'reported',
            settable: true
          }
        ],
        optionSurface: {
          getSnapshot: () => [],
          setOption: vi.fn(),
          invokeAction: vi.fn(),
          subscribe: () => () => {}
        },
        setStructuredOption: vi.fn()
      }
    }
  }
})

vi.mock('./use-native-chat-font-scale', () => ({
  useNativeChatFontScale: () => ({ scale: 1 })
}))

vi.mock('./use-native-chat-file-link-context', () => ({
  useNativeChatFileLinkContext: () => ({
    worktreeId: 'wt-1',
    worktreePath: '/repo',
    runtimeEnvironmentId: null
  })
}))

vi.mock('./use-native-chat-file-link-click', () => ({
  useNativeChatFileLinkClick: (context: unknown) => (context ? mocks.fileLinkClick : undefined)
}))

vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: (props: typeof mocks.messageListProps) => {
    mocks.messageListProps = props
    return <div data-testid="message-list" />
  }
}))

vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: (props: typeof mocks.composerProps) => {
    mocks.composerProps = props
    return null
  }
}))
vi.mock('./NativeChatEmptyState', () => ({ NativeChatEmptyState: () => null }))
vi.mock('./NativeChatApprovalCard', () => ({ NativeChatApprovalCard: () => null }))
vi.mock('./NativeChatQuestionCard', () => ({ NativeChatQuestionCard: () => null }))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

describe('NativeChatStructuredSession', () => {
  afterEach(() => {
    cleanup()
    mocks.call.mockReset()
    mocks.mode = 'static'
    mocks.messageListProps = null
    mocks.composerProps = null
  })

  it('wires local structured file links through the native chat opener', () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )

    expect(mocks.messageListProps?.allowFileUriLinks).toBe(true)
    expect(mocks.messageListProps?.onLinkClick).toBe(mocks.fileLinkClick)
  })

  it('routes a bare model command to the native option picker', async () => {
    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )
    const dispatchCommand = mocks.composerProps?.structuredTransport?.dispatchCommand as
      | ((text: string) => Promise<{ accepted: boolean }>)
      | undefined

    await act(async () => {
      await expect(dispatchCommand?.('/model')).resolves.toMatchObject({ accepted: true })
    })

    expect(mocks.composerProps?.structuredTransport?.optionPickerRequest).toEqual({
      id: 'model',
      sequence: 1
    })
  })

  it('retries an unconfirmed transport send and clears the delivery notice', async () => {
    mocks.mode = 'outbox'
    mocks.call.mockRejectedValueOnce(new Error('socket closed')).mockResolvedValueOnce({
      ok: true,
      value: {
        submission: {
          clientMessageId: 'client-1',
          dispatchState: 'accepted'
        }
      }
    })

    render(
      <NativeChatStructuredSession
        isVisible
        tabId="structured-tab-1"
        sessionId="session-1"
        target={{ kind: 'local' }}
        agent="codex"
        allowFileUriLinks
      />
    )

    const send = mocks.composerProps?.structuredTransport?.send as
      | ((text: string, attachments: readonly { id: string; path: string }[]) => boolean)
      | undefined
    expect(send?.('hello', [])).toBe(true)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText('Message delivery is unconfirmed.')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /Retry/ }))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('Message delivery is unconfirmed.')).toBeNull())
  })
})
