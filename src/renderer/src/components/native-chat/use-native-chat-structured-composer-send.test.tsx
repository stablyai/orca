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

function harness(
  agent: AgentType,
  threadGoal?: NativeChatStructuredComposerTransport['threadGoal'],
  onSubmitted?: () => void
) {
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
  if (threadGoal) {
    structuredTransport.threadGoal = threadGoal
  }
  structuredTransport.onSubmitted = onSubmitted
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent,
      draftScopeKey: 'tab-1:pane',
      imageAttachments: [ATTACHMENT],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
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

  it('refuses attachments on /goal where the host sets the goal, since no message is sent', () => {
    const setObjective = vi.fn(async () => true)
    const { send, structuredTransport } = harness('codex', { setObjective })
    send('/goal ship the fix')
    expect(structuredTransport.onError).toHaveBeenCalledWith(
      'Remove attachments before using a chat-session command.'
    )
    expect(setObjective).not.toHaveBeenCalled()
    expect(structuredTransport.send).not.toHaveBeenCalled()
  })
})

describe('an attachment still uploading', () => {
  it('holds a picked command, as Send is held, rather than send the chip without its path', async () => {
    const { send, structuredTransport } = harness('claude')
    const pending: NativeChatComposerImageAttachment = {
      id: 'p1',
      path: '',
      pending: true,
      pendingName: 'notes.pdf'
    }
    send('/review', [pending])
    await Promise.resolve()
    expect(structuredTransport.send).not.toHaveBeenCalled()
    expect(structuredTransport.onError).not.toHaveBeenCalled()
  })
})

// The pane brings the latest into view on this: a conversation command at the press, a message
// once admitted, and neither for a refusal or a command the chat does not run.
describe('reports the sends that bring the latest into view', () => {
  it('reports a conversation command at the press, then not a message the transport refused', async () => {
    const onSubmitted = vi.fn()
    const { send, structuredTransport } = harness('claude', undefined, onSubmitted)
    send('/compact', [])
    expect(onSubmitted).toHaveBeenCalledOnce()

    vi.mocked(structuredTransport.send).mockReturnValue(false)
    send('hello', [])
    await vi.waitFor(() => expect(structuredTransport.onError).toHaveBeenCalledTimes(2))
    expect(structuredTransport.send).toHaveBeenCalledWith('hello', [])
    expect(onSubmitted).toHaveBeenCalledOnce()
  })

  it('reports nothing for a host command chat sessions do not run', async () => {
    const onSubmitted = vi.fn()
    const { send, structuredTransport } = harness('codex', undefined, onSubmitted)
    send('/permissions', [])
    await vi.waitFor(() =>
      expect(structuredTransport.onError).toHaveBeenCalledWith(
        expect.stringContaining('not available in chat sessions')
      )
    )
    expect(onSubmitted).not.toHaveBeenCalled()
  })
})

describe("says a failed send in Orca's words, with the error it hit apart", () => {
  it('keeps a main-process failure apart from the words saying the message was not sent', async () => {
    const { send, structuredTransport } = harness('claude')
    vi.mocked(structuredTransport.send).mockImplementation(() => {
      throw new Error(
        "Error invoking remote method 'agentSession:send': Error: connect ECONNREFUSED /tmp/a.sock"
      )
    })
    send('hello', [])
    await vi.waitFor(() =>
      expect(structuredTransport.onError).toHaveBeenCalledWith(
        'Your message was not sent.',
        'connect ECONNREFUSED /tmp/a.sock'
      )
    )
  })
})
