// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fileLinkClick: vi.fn(),
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
  },
  composerProps: null as null | { structuredTransport?: Record<string, unknown> }
}))

vi.mock('./use-structured-agent-session', () => ({
  useStructuredAgentSession: () => ({
    messages: [
      {
        id: 'message-1',
        role: 'assistant',
        source: 'transcript',
        timestamp: 1,
        blocks: [{ type: 'text', text: '[file](file:///repo/src/main.ts)' }]
      }
    ],
    status: 'ready',
    error: null,
    hasOlder: false,
    loadingOlder: false,
    loadOlder: vi.fn(),
    prompts: [],
    outbox: [],
    blockedClientMessageId: null,
    send: vi.fn(),
    retry: vi.fn(),
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
  })
}))

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
})
