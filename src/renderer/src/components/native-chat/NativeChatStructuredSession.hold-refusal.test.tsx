// @vitest-environment happy-dom

// Opening a chat holds its session, and the hold may resume it on the host. When the host refuses
// (e.g. the chat's folder is gone), the chat must say why instead of sitting there silently.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { mocks, moduleFactories, resetStructuredSessionMocks } = await vi.hoisted(async () =>
  (await import('./NativeChatStructuredSession.test-harness')).createStructuredSessionMocks()
)

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: vi.fn(() => new Promise(() => {})),
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: () => {} })),
  supportsStructuredAgentSessionPromptCancel: vi.fn().mockResolvedValue(false)
}))
vi.mock('./use-native-chat-font-scale', () => moduleFactories.useNativeChatFontScale())
vi.mock('./use-native-chat-file-link-context', () => moduleFactories.useNativeChatFileLinkContext())
vi.mock('./use-native-chat-tab-owner', () => moduleFactories.useNativeChatTabOwner())
vi.mock('./use-native-chat-file-link-click', () => moduleFactories.useNativeChatFileLinkClick())
vi.mock('./NativeChatMessageList', () => moduleFactories.nativeChatMessageList())
vi.mock('./NativeChatComposer', () => moduleFactories.nativeChatComposer())
vi.mock('./NativeChatEmptyState', () => moduleFactories.nativeChatEmptyState())
vi.mock('./NativeChatApprovalCard', () => moduleFactories.nativeChatApprovalCard())
vi.mock('./NativeChatQuestionCard', () => moduleFactories.nativeChatQuestionCard())

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const FOLDER_GONE =
  'The folder this chat ran in no longer exists: /gone/folder. Restore it to continue.'

function rejectHold(code: string, message: string): void {
  mocks.call.mockImplementation((...args: never[]) => {
    const method: unknown = args[1]
    return method === 'agentSession.hold'
      ? Promise.reject(new RuntimeRpcCallError({ id: 'hold', ok: false, error: { code, message } }))
      : new Promise(() => {})
  })
}

function renderChat(): void {
  render(
    <NativeChatStructuredSession
      isVisible
      isFocusedGroup
      tabId="structured-tab-gone"
      sessionId="session-gone"
      target={{ kind: 'local' }}
      agent="codex"
    />
  )
}

function holdCalls(): number {
  return mocks.call.mock.calls.filter((call) => {
    const method: unknown = call[1]
    return method === 'agentSession.hold'
  }).length
}

describe('NativeChatStructuredSession hold refusal', () => {
  afterEach(async () => {
    cleanup()
    // Let the unmount's release (chained off the hold) run before the mock is reset.
    await new Promise((resolve) => setTimeout(resolve, 0))
    resetStructuredSessionMocks()
  })

  it("shows the host's reason the session could not be opened", async () => {
    rejectHold('agent_session_operation_invalid', FOLDER_GONE)
    renderChat()

    await waitFor(() => expect(screen.getByText(FOLDER_GONE)).toBeTruthy())
  })

  it('shows nothing when an older host has no hold method', async () => {
    rejectHold('method_not_found', 'Unknown method: agentSession.hold')
    renderChat()

    await waitFor(() => expect(holdCalls()).toBe(1))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(screen.queryByText('Unknown method: agentSession.hold')).toBeNull()
  })
})
