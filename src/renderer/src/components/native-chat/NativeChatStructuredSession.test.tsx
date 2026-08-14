// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fileLinkClick: vi.fn(),
  messageListProps: null as null | {
    allowFileUriLinks?: boolean
    onLinkClick?: (...args: unknown[]) => void
  }
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
    optionSnapshot: [],
    optionSurface: null,
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

vi.mock('./NativeChatComposer', () => ({ NativeChatComposer: () => null }))
vi.mock('./NativeChatEmptyState', () => ({ NativeChatEmptyState: () => null }))
vi.mock('./NativeChatApprovalCard', () => ({ NativeChatApprovalCard: () => null }))
vi.mock('./NativeChatQuestionCard', () => ({ NativeChatQuestionCard: () => null }))

import { NativeChatStructuredSession } from './NativeChatStructuredSession'

describe('NativeChatStructuredSession', () => {
  afterEach(() => {
    cleanup()
    mocks.messageListProps = null
  })

  it('wires local structured file links through the native chat opener', () => {
    render(
      <NativeChatStructuredSession
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
})
