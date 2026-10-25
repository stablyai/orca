// @vitest-environment happy-dom
import { structuredAgentSessionSendBody } from '../../../../shared/structured-agent-session-send-mutation'
import {
  clearNativeChatComposerDraftsForTests,
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from './native-chat-composer-draft-store'
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
  const structuredTransport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
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
    optionsSurface: {
      getSnapshot: () => [],
      setOption: vi.fn(),
      invokeAction: vi.fn(),
      subscribe: () => () => {}
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'session-test',
    runtimeEnvironmentId: null
  }
  if (threadGoal) {
    structuredTransport.threadGoal = threadGoal
  }
  structuredTransport.onSubmitted = onSubmitted
  const setDraft = vi.fn()
  const { result } = renderHook(() =>
    useNativeChatStructuredComposerSend({
      agent,
      draftScopeKey: 'tab-1:pane',
      imageAttachments: [ATTACHMENT],
      structuredTransport,
      isComposing: () => false,
      clearSkillOrigin: vi.fn(),
      setDraft,
      setCaret: vi.fn()
    })
  )
  return { send: result.current, structuredTransport, setDraft }
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
        expect.stringContaining('not available in chat sessions'),
        undefined
      )
    )
    expect(onSubmitted).not.toHaveBeenCalled()
  })
})

// STA-10671: an older paired host would run the turn without the approval the chat asks for.
describe('a send held by its host', () => {
  it('starts no turn, but still lets an option command through', async () => {
    const { send, structuredTransport } = harness('claude')
    structuredTransport.sendBlockedReason = 'Update Orca on this host to use Ask for approval.'
    await send('hello', [])
    await send('/compact', [])
    expect(structuredTransport.send).not.toHaveBeenCalled()
    expect(structuredTransport.onError).not.toHaveBeenCalled()

    await send('/model', [])
    expect(structuredTransport.onError).toHaveBeenCalled()
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
      expect(structuredTransport.onError).toHaveBeenCalledWith('Your message was not sent.', {
        errorText: 'connect ECONNREFUSED /tmp/a.sock'
      })
    )
    updateNativeChatComposerDraft('tab-1:pane', { text: '$review' }, 'immediate')
    const before = readNativeChatComposerDraft('tab-1:pane')
    vi.mocked(structuredTransport.send).mockImplementation((text) =>
      Boolean(
        structuredAgentSessionSendBody(
          text,
          [],
          Array.from({ length: 17 }, (_, path) => ({ name: 'review', path: `/${path}` }))
        )
      )
    )
    await send('$review', [])
    expect(readNativeChatComposerDraft('tab-1:pane')).toBe(before)
    expect(structuredTransport.onError).toHaveBeenLastCalledWith(
      'Your message was not sent to Claude. Keep at most 16 selected skill files and try again.',
      { errorText: undefined }
    )
  })
})

it('settles captured command text without publishing obsolete notices', async () => {
  const { send, structuredTransport } = harness('codex', { setObjective: async () => true })
  const reply =
    Promise.withResolvers<Awaited<ReturnType<typeof structuredTransport.dispatchCommand>>>()
  let current = true
  structuredTransport.capturePresentation = () => () => current
  structuredTransport.dispatchCommand = () => reply.promise
  updateNativeChatComposerDraft('tab-1:pane', { text: '/goal ship it' }, 'immediate')
  const pending = send('/goal ship it', [])
  current = false
  updateNativeChatComposerDraft('tab-1:pane', { text: '/goal ship it next' }, 'immediate')
  reply.resolve({ handled: true, accepted: true, error: null })
  await pending
  expect(readNativeChatComposerDraft('tab-1:pane').text).toBe(' next')
  expect(structuredTransport.onError).not.toHaveBeenCalled()
})

it('checks both the picked command and its draft, and projects completed paths', async () => {
  const { send, structuredTransport } = harness('claude')
  const id = '00000000-0000-4000-8000-000000000000'
  const token = `[Pasted text](orca-paste:${id})`
  await send(token, [])
  updateNativeChatComposerDraft('tab-1:pane', { text: token }, 'immediate')
  await send('/review', [])
  expect(structuredTransport.send).not.toHaveBeenCalled()
  updateNativeChatComposerDraft(
    'tab-1:pane',
    { pastedTextFiles: { [id]: '/p/saved.txt' } },
    'immediate'
  )
  await send(`a${token}${token}b`, [])
  expect(structuredTransport.send).toHaveBeenCalledWith('a @/p/saved.txt @/p/saved.txt b', [])
  clearNativeChatComposerDraftsForTests()
})

it.each(['claude', 'codex'] as const)(
  'keeps an oversized %s draft before transport admission',
  async (agent) => {
    clearNativeChatComposerDraftsForTests()
    const { send, structuredTransport, setDraft } = harness(agent)
    const text = 'x'.repeat(270014)
    updateNativeChatComposerDraft('tab-1:pane', { text }, 'immediate')
    const submitted = readNativeChatComposerDraft('tab-1:pane')
    await send(text, [])
    expect(structuredTransport.send).not.toHaveBeenCalled()
    expect(structuredTransport.onError).toHaveBeenCalledWith(
      expect.stringContaining('over the 256 KB limit'),
      undefined
    )
    expect(setDraft).not.toHaveBeenCalled()
    expect(readNativeChatComposerDraft('tab-1:pane')).toBe(submitted)
    clearNativeChatComposerDraftsForTests()
  }
)
