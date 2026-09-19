// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { useNativeChatStructuredComposerSend } from './use-native-chat-structured-composer-send'

vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatMessageSent: vi.fn() }))
vi.mock('@/lib/worker-terminal-takeover-report', () => ({
  reportStructuredSessionUserInput: vi.fn()
}))

const ATTACHMENT = { id: 'a1', path: '/tmp/shot.png' } as NativeChatComposerImageAttachment

function harness(agent: AgentType) {
  const structuredTransport = {
    send: vi.fn(() => true),
    dispatchCommand: (text: string) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        agent,
        snapshot: [],
        invokeAction: async () => true,
        setOption: async () => true,
        conversationCommands: ['clear', 'compact'],
        runConversationCommand: async () => ({ accepted: true, error: null })
      }),
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-test',
    runtimeEnvironmentId: null
  } as unknown as NativeChatStructuredComposerTransport
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent,
      draft: '',
      imageAttachments: [ATTACHMENT],
      structuredTransport,
      clearImageAttachments: vi.fn(),
      clearSkillOrigin: vi.fn(),
      setHistory: vi.fn(),
      setDraft: vi.fn(),
      setCaret: vi.fn()
    })
  )
  return { send: result.current, structuredTransport }
}

// The guard exists because a host command sends no message, so its attachments
// would be dropped without a word. A pass-through command IS the message, so the
// attachments ride along with it.
describe('attachment guard follows what the host claims', () => {
  it.each([
    ['claude', '/clear'],
    ['claude', '/model'],
    ['codex', '/permissions']
  ] as const)('refuses attachments on the host-claimed %s command %s', (agent, text) => {
    const { send, structuredTransport } = harness(agent)
    send(text)
    expect(structuredTransport.onError).toHaveBeenCalledWith(
      'Remove attachments before using a chat-session command.'
    )
    expect(structuredTransport.send).not.toHaveBeenCalled()
  })

  it.each([
    ['claude', '/init'],
    ['claude', '/review'],
    ['codex', '/goal ship the fix']
  ] as const)('sends %s attachments along with the passed-through %s', async (agent, text) => {
    const { send, structuredTransport } = harness(agent)
    send(text)
    await vi.waitFor(() =>
      expect(structuredTransport.send).toHaveBeenCalledWith(text, [ATTACHMENT])
    )
    expect(structuredTransport.onError).not.toHaveBeenCalledWith(
      'Remove attachments before using a chat-session command.'
    )
  })
})
