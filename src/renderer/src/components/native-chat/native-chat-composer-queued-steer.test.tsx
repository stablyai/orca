// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session/requests/agent-session-queued-message-wire'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import type { StructuredAgentSessionPendingSend } from './structured-agent-session-pending-sends'

const transport = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: transport.call
}))

const messages = [
  {
    messageId: 'older',
    position: 1,
    state: 'waiting',
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Wait until later' }] }
  },
  {
    messageId: 'just-queued',
    position: 2,
    state: 'waiting',
    body: {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'Actually send this now' },
        { type: 'image-ref', path: '/attachment.png' }
      ]
    }
  }
] satisfies AgentSessionQueuedMessage[]

type ComposerProps = {
  target?: RuntimeClientTarget
  cards?: AgentSessionQueuedMessage[]
  draft?: string
  hasAttachments?: boolean
  chordSteersQueued?: boolean
  enabled?: boolean
  composing?: boolean
  sending?: StructuredAgentSessionPendingSend[]
}

const LOCAL_TARGET: RuntimeClientTarget = { kind: 'local' }

function Composer({
  target = LOCAL_TARGET,
  cards = messages,
  draft = '',
  hasAttachments = false,
  chordSteersQueued = true,
  enabled = true,
  composing = false,
  sending
}: ComposerProps): React.JSX.Element {
  const writes = useStructuredAgentSessionMutate({
    target,
    sessionId: 'chat-1',
    stateRef: { current: { fence: 7 } }
  })
  const queue = useStructuredAgentSessionQueuedMessages({
    enabled,
    queuedMessages: cards,
    queuePause: null,
    submissions: [],
    hasPendingPrompt: false,
    isWorking: true,
    sending,
    composerScopeKey: undefined,
    ...writes,
    editTransport: { target, sessionId: 'chat-1', capable: false, write: writes.write }
  })
  const onKeyDown = useNativeChatComposerKeyDown({
    autocomplete: { mode: 'none' },
    activeSuggestion: 0,
    draft,
    hasAttachments,
    chordSteersQueued,
    mentionFiles: { files: [], loading: false, failed: false },
    completeMention: () => {},
    isComposing: () => composing,
    completePickerItem: () => {},
    dispatchPickerCommand: () => {},
    dismissPicker: () => {},
    interrupt: () => {},
    send: () => {},
    steerHead: queue.steerHead,
    steerLast: queue.steerLast,
    setActiveSuggestion: () => {},
    setDraft: () => {},
    setCaret: () => {}
  })
  return <textarea aria-label="composer" value={draft} readOnly onKeyDown={onKeyDown} />
}

beforeEach(() => {
  transport.call.mockReturnValue(new Promise(() => {}))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

it.each([
  ['Macintosh', { metaKey: true }],
  ['Windows', { ctrlKey: true }],
  ['Linux', { ctrlKey: true }]
])('steers the last queued message once from an empty composer on %s', async (platform, chord) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
  const pending = Promise.withResolvers<unknown>()
  transport.call.mockReturnValue(pending.promise)
  const view = render(<Composer draft={' \n'} />)
  const field = view.getByRole('textbox')
  fireEvent.keyDown(field, { key: 'Enter', ...chord })
  fireEvent.keyDown(field, { key: 'Enter', ...chord })
  expect(transport.call.mock.calls).toEqual([
    [
      { kind: 'local' },
      'agentSession.queuedMessageSend',
      {
        messageId: 'just-queued',
        envelope: {
          sessionId: 'chat-1',
          expectedRuntimeFence: 7,
          clientOperationId: expect.any(String),
          payloadFingerprint: expect.any(String)
        }
      }
    ]
  ])
  await act(async () => {
    pending.resolve({ ok: true, value: { accepted: true } })
  })
  view.rerender(<Composer cards={[messages[0]]} />)
  fireEvent.keyDown(field, { key: 'Enter', repeat: true, ...chord })
  expect(transport.call).toHaveBeenCalledTimes(1)
})

it('keeps the explicit Shift chord on the head and routes remote sends through their host', () => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
  transport.call.mockReturnValue(new Promise(() => {}))
  const view = render(
    <Composer draft="Keep this draft" target={{ kind: 'environment', environmentId: 'remote' }} />
  )
  fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', metaKey: true, shiftKey: true })
  expect(transport.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'remote' },
    'agentSession.queuedMessageSend',
    expect.objectContaining({ messageId: 'older' })
  )
  expect(view.container.querySelector('textarea')?.value).toBe('Keep this draft')
})

it.each([
  { draft: 'New text' },
  { hasAttachments: true },
  { chordSteersQueued: false },
  { composing: true },
  { enabled: false },
  { cards: [] },
  {
    sending: [
      {
        clientMessageId: 'still-queuing',
        sessionId: 'chat-1',
        body: messages[1].body,
        delivery: 'queue-if-active',
        previewUris: [],
        queuedAt: 1,
        phase: 'sending',
        issued: true
      }
    ]
  },
  { cards: [messages[0], { ...messages[1], paused: true }] },
  { cards: [messages[0], { ...messages[1], state: 'returned' }] }
] satisfies ComposerProps[])(
  'never substitutes an older queued message for unavailable input: %j',
  (props) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    const view = render(<Composer {...props} />)
    fireEvent.keyDown(view.getByRole('textbox'), { key: 'Enter', metaKey: true })
    expect(transport.call).not.toHaveBeenCalled()
  }
)
