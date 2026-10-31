// @vitest-environment happy-dom

// Enter and Cmd/Ctrl+Enter reach the outgoing agentSession.send through the real composer, transport and session.

import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor
} from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn(), ptySend: vi.fn(() => null) }))

vi.mock('./native-chat-runtime-send', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sendNativeChatMessage: mocks.ptySend
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  subscribeStructuredAgentSessionStatus: vi.fn(async () => ({ unsubscribe: vi.fn() })),
  callStructuredAgentSession: mocks.call,
  supportsStructuredAgentSessionPromptCancel: vi.fn(async () => false)
}))

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'provider-turn', state: 'running' }
}

let readItems: AgentJournalRenderItem[] = [RUNNING_TURN]
let readQueued: AgentSessionQueuedMessage[] = []
let currentRequests: AgentJournalRenderItem[] | undefined

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items: readItems,
      currentRequests,
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      queuedMessages: readQueued,
      nextQueuedMessageId: null
    },
    loadingOlder: false,
    loadOlder: vi.fn()
  })
}))
vi.mock('./native-chat-shortcut', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isMacPlatform: () => true
}))
vi.mock('@/lib/shortcut-platform', () => ({ getShortcutPlatform: () => 'darwin' }))
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))

import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { i18n } from '@/i18n/i18n'
import de from '@/i18n/locales/de.json'
import type { AgentSessionQueuedMessage } from '../../../../shared/agent-session-wire'
import { isAdmissibleAgentJournalItemBody } from '../../../../shared/agent-session-journal-schemas'
import {
  updateNativeChatComposerDraft,
  clearNativeChatComposerDraftsForTests
} from './native-chat-composer-draft-store'
import {
  addNativeChatPendingAttachment,
  clearNativeChatPendingAttachments
} from './native-chat-pending-attachment-cache'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposer } from './NativeChatComposer'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { useNativeChatStructuredComposerTransport } from './use-native-chat-structured-composer-transport'
import * as queueRequests from './structured-agent-session-queue-request'
import { nativeChatStructuredStopControls } from './native-chat-structured-stop-controls'
import { changePrompt, promptValue } from './native-chat-prompt-editor.test-support'

function Chat({
  queueFollowUps,
  hostStopping = false
}: {
  queueFollowUps: boolean
  hostStopping?: boolean
}): React.JSX.Element {
  const props = { agent: 'claude', sessionId: 'session-1', target: { kind: 'local' } } as const
  const controller = useStructuredAgentSession({
    ...props,
    isVisible: true,
    composerScopeKey: `alternate-send-${queueFollowUps}`,
    queueFollowUps,
    hostStopping
  })
  const transport = useNativeChatStructuredComposerTransport({
    props,
    controller,
    sendThroughLaunch: (_text, _withImages, send) => send(),
    starting: false,
    transportEnabled: true,
    worktreeId: undefined,
    optionPickerRequest: null,
    setOptionPickerRequest: () => {},
    onError: vi.fn(),
    onSubmitted: () => {}
  })
  return (
    <NativeChatComposer
      terminalTabId={`tab-alternate-${queueFollowUps}`}
      paneKey={`tab-alternate-${queueFollowUps}:structured`}
      draftScopeKey={`alternate-send-${queueFollowUps}`}
      targetPtyId={null}
      agent="claude"
      {...nativeChatStructuredStopControls(controller, false).composer}
      structuredTransport={transport}
    />
  )
}

function sends(): Record<string, unknown>[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.send')
    .map(([, , params]) => params)
}

async function type(text: string, key: { metaKey?: boolean } = {}): Promise<void> {
  const input = screen.getByRole('textbox')
  changePrompt(input, text)
  await act(async () => {
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false, ...key })
  })
}

beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  clearNativeChatPendingAttachments('operation')
  readItems = [RUNNING_TURN]
  readQueued = []
  currentRequests = undefined
  mocks.call.mockReset()
  mocks.call.mockImplementation(async (_target, method) =>
    method === 'agentSession.send'
      ? {
          ok: true,
          replayed: false,
          fence: 3,
          cursor: { epoch: 'e', sequence: 2 },
          value: {
            clientMessageId: 'c',
            submission: {
              clientMessageId: 'c',
              fence: 3,
              payloadFingerprint: 'fingerprint',
              dispatchState: 'accepted',
              providerItemId: null,
              reason: null,
              submittedAt: 10,
              resolvedAt: 10
            }
          }
        }
      : null
  )
  setLocalRuntimeCapabilitiesForTests([
    AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
    AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
  ])
})

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('en')
  setLocalRuntimeCapabilitiesForTests(null)
})

describe('mid-turn send keys on a host that queues', () => {
  it.each([
    { queueFollowUps: true, enter: 'queue-if-active', alternate: undefined },
    { queueFollowUps: false, enter: undefined, alternate: 'queue-if-active' }
  ])(
    'with queueing $queueFollowUps, Enter and Cmd+Enter reach the host the opposite ways',
    async ({ queueFollowUps, enter, alternate }) => {
      render(
        <TooltipProvider>
          <Chat queueFollowUps={queueFollowUps} />
        </TooltipProvider>
      )
      await type('by enter')
      await type('by cmd enter', { metaKey: true })
      expect(sends().map((params) => params.delivery)).toEqual([enter, alternate])
    }
  )

  it.each([
    {
      queueFollowUps: true,
      hint: '⌘ Enter to steer',
      enter: 'queue-if-active',
      alternate: undefined
    },
    {
      queueFollowUps: false,
      hint: '⌘ Enter to queue',
      enter: undefined,
      alternate: 'queue-if-active'
    }
  ])(
    'with queueing $queueFollowUps, a typed draft turns Stop into Send, which sends like Enter and names what Cmd+Enter does',
    async ({ queueFollowUps, hint, enter, alternate }) => {
      render(
        <TooltipProvider>
          <Chat queueFollowUps={queueFollowUps} />
        </TooltipProvider>
      )
      expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
      changePrompt(screen.getByRole('textbox'), 'by click')
      expect(screen.queryByRole('button', { name: 'Stop the agent' })).toBeNull()
      const send = screen.getByRole('button', { name: 'Send' })
      act(() => send.focus())
      expect((await screen.findByRole('tooltip')).textContent).toBe(hint)
      await act(async () => {
        fireEvent.click(send)
      })
      // The hint names what Cmd+Enter then actually asks of the host.
      await type('by cmd enter', { metaKey: true })
      await act(async () =>
        updateNativeChatComposerDraft(
          `alternate-send-${queueFollowUps}`,
          { images: [{ id: 'image', path: '/tmp/alternate.png' }] },
          'immediate'
        )
      )
      act(() => screen.getByRole('button', { name: 'Send' }).focus())
      expect((await screen.findByRole('tooltip')).textContent).toBe(hint)
      await type('', { metaKey: true })
      expect(sends().map((params) => params.delivery)).toEqual([enter, alternate, alternate])
      expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeTruthy()
    }
  )
})

function operationTransport(overrides: Partial<NativeChatStructuredComposerTransport> = {}) {
  const send = vi.fn(() => true)
  const setObjective = vi.fn(async () => true)
  const invokeAction = vi.fn(async () => true)
  const runConversationCommand = vi.fn(async () => ({ accepted: true, error: null }))
  const transport: NativeChatStructuredComposerTransport = {
    capturePresentation: () => () => true,
    send,
    dispatchCommand: (text) =>
      dispatchStructuredAgentSessionComposerCommand(text, {
        snapshot: [],
        invokeAction,
        setOption: async () => true,
        conversationCommands: ['compact', 'clear'],
        runConversationCommand,
        setThreadGoalObjective: setObjective
      }),
    sendFollowUp: { action: 'queue', offersChoice: true },
    threadGoal: { setObjective },
    optionsSurface: {
      getSnapshot: () => [],
      subscribe: () => () => {},
      invokeAction: async () => ({ snapshot: [] }),
      setOption: async () => ({ snapshot: [] })
    },
    optionSnapshot: [],
    onError: vi.fn(),
    runtime: 'local',
    sessionId: 'operation',
    runtimeEnvironmentId: null,
    ...overrides
  }
  render(
    <TooltipProvider>
      <NativeChatComposer
        terminalTabId="operation"
        paneKey="operation"
        targetPtyId={null}
        agent="claude"
        isWorking
        onStop={() => {}}
        structuredTransport={transport}
      />
    </TooltipProvider>
  )
  return { send, setObjective, invokeAction, runConversationCommand }
}

it.each(['/compact', '/clear', '/model', '/effort', '/goal ship it', '/resume search'])(
  '%s never promises alternate message delivery and retains its real command outcome',
  async (draft) => {
    const calls = operationTransport()
    changePrompt(screen.getByRole('textbox'), draft)
    act(() => screen.getByRole('button', { name: 'Send' }).focus())
    expect(screen.queryByRole('tooltip')).toBeNull()
    await type(draft, { metaKey: true })
    expect(calls.send).not.toHaveBeenCalled()
    if (draft === '/compact' || draft === '/clear') {
      expect(calls.runConversationCommand).toHaveBeenCalledWith(draft.slice(1))
    } else if (draft === '/model' || draft === '/effort') {
      expect(calls.invokeAction).toHaveBeenCalledWith(draft.slice(1))
    } else if (draft.startsWith('/goal')) {
      expect(calls.setObjective).toHaveBeenCalledWith('ship it')
    } else {
      expect(
        screen.getByText("This chat's workspace isn't loaded yet. Try /resume again in a moment.")
      ).toBeTruthy()
      expect(promptValue(screen.getByRole('textbox'))).toBe(draft)
    }
  }
)

it('goal mode hides delivery hints and modified Enter still sets the objective', async () => {
  const calls = operationTransport()
  await type('/goal', { metaKey: true })
  changePrompt(screen.getByRole('textbox'), 'ship it')
  act(() => screen.getByRole('button', { name: 'Send' }).focus())
  expect(screen.queryByRole('tooltip')).toBeNull()
  await type('ship it', { metaKey: true })
  await waitFor(() => expect(calls.setObjective).toHaveBeenCalledWith('ship it'))
  expect(calls.send).not.toHaveBeenCalled()
})

it('an unknown slash draft retains its real alternate message hint and delivery', async () => {
  const calls = operationTransport()
  changePrompt(screen.getByRole('textbox'), '/unknown ordinary prompt')
  act(() => screen.getByRole('button', { name: 'Send' }).focus())
  expect((await screen.findByRole('tooltip')).textContent).toBe('⌘ Enter to steer')
  await type('/unknown ordinary prompt', { metaKey: true })
  expect(calls.send).toHaveBeenCalledWith('/unknown ordinary prompt', [], { alternate: true })
})

it.each(['idle', 'stopping', 'old host', 'waiting command', 'unanswerable prompt'])(
  '%s withdraws the rendered alternate hint',
  async (state) => {
    if (state === 'idle') {
      readItems = []
    }
    if (state === 'old host') {
      setLocalRuntimeCapabilitiesForTests([])
    }
    if (state === 'waiting command') {
      readQueued = [
        {
          messageId: 'command',
          position: 1,
          state: 'waiting',
          body: {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: '/compact' }],
            command: { name: 'compact' }
          }
        }
      ]
    }
    if (state === 'unanswerable prompt') {
      const body = {
        kind: 'approval',
        title: 'Review',
        detail: null,
        subject: { kind: 'diff' },
        options: [{ id: 'allow', label: 'Approve' }],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      }
      if (!isAdmissibleAgentJournalItemBody(body)) {
        throw new Error('Invalid approval fixture')
      }
      readItems = [
        ...readItems,
        { itemId: 'prompt', revision: 1, sequence: 2, observedAt: 1, body }
      ]
    }
    render(
      <TooltipProvider>
        <Chat queueFollowUps hostStopping={state === 'stopping'} />
      </TooltipProvider>
    )
    await act(async () => {})
    changePrompt(screen.getByRole('textbox'), 'next message')
    act(() => screen.getByRole('button', { name: 'Send' }).focus())
    expect(screen.queryByRole('tooltip')).toBeNull()
  }
)

it.each([false, true])(
  'renders the actual German alternate output with Queue %s',
  async (queueFollowUps) => {
    i18n.addResourceBundle('de', 'translation', de)
    await i18n.changeLanguage('de')
    render(
      <TooltipProvider>
        <Chat queueFollowUps={queueFollowUps} />
      </TooltipProvider>
    )
    changePrompt(screen.getByRole('textbox'), 'weiter')
    act(() => screen.getByRole('button', { name: 'Senden' }).focus())
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      queueFollowUps ? '⌘ Enter zum Steuern' : '⌘ Enter zum Einreihen'
    )
  }
)

it.each(['click', 'enter'])('a rejected %s leaves the draft available to retry', async (action) => {
  const send = vi.fn(() => false)
  operationTransport({ send })
  changePrompt(screen.getByRole('textbox'), 'keep this draft')
  await act(async () => {
    if (action === 'click') {
      fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    } else {
      fireEvent.keyDown(screen.getByRole('textbox'), {
        key: 'Enter',
        keyCode: 13,
        isComposing: false
      })
    }
  })
  expect(send).toHaveBeenCalledWith('keep this draft', [])
  expect(promptValue(screen.getByRole('textbox'))).toBe('keep this draft')
})

it.each(['available', 'pending', 'unavailable'])(
  'keeps image-only %s Send and its existing hold',
  async (state) => {
    if (state === 'pending') {
      addNativeChatPendingAttachment('operation', { id: 'image', path: '', pending: true })
    } else {
      updateNativeChatComposerDraft(
        'operation',
        {
          images: [
            {
              id: 'image',
              path: state === 'available' ? '/tmp/image.png' : '',
              ...(state === 'unavailable' ? { unavailableName: 'image.png' } : {})
            }
          ]
        },
        'immediate'
      )
    }
    const calls = operationTransport({
      sendBlockedReason: state === 'unavailable' ? 'host reason' : undefined
    })
    const button = screen.getByRole('button', {
      name: state === 'unavailable' ? /image.*brought back/i : 'Send'
    })
    expect(button.hasAttribute('disabled')).toBe(state !== 'available')
    act(() => button.focus())
    if (state === 'available') {
      expect((await screen.findByRole('tooltip')).textContent).toBe('⌘ Enter to steer')
      await act(async () => fireEvent.click(button))
      expect(calls.send).toHaveBeenCalledWith('', [
        expect.objectContaining({ id: 'image', path: '/tmp/image.png' })
      ])
    } else {
      await type('', { metaKey: true })
      expect(calls.send).not.toHaveBeenCalled()
      if (state === 'unavailable') {
        expect(screen.queryByText('host reason')).toBeNull()
      }
    }
  }
)

it('the running PTY composer clicks through Send while Escape still stops without losing the next draft', async () => {
  const stop = vi.fn()
  render(
    <TooltipProvider>
      <NativeChatComposer
        terminalTabId="pty-tab"
        paneKey="pty-pane"
        targetPtyId="pty-1"
        agent="claude"
        isWorking
        onStop={stop}
      />
    </TooltipProvider>
  )
  expect(screen.getByRole('button', { name: 'Stop the agent' })).toBeTruthy()
  changePrompt(screen.getByRole('textbox'), 'pty message')
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })))
  expect(mocks.ptySend).toHaveBeenCalledWith('pty-1', 'pty message', expect.any(Object))
  expect(stop).not.toHaveBeenCalled()
  changePrompt(screen.getByRole('textbox'), 'keep this one')
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(stop).toHaveBeenCalledOnce()
  expect(promptValue(screen.getByRole('textbox'))).toBe('keep this one')
})

// Count only the real send resolver's population reads, separate from existing card/history projections.
it.each([10, 100])(
  'bounds follow-up presentation work at %s queued rows and prompts on a journal render',
  async (size) => {
    const original = queueRequests.structuredAgentSessionSendQueues
    let resolving = false
    let queueReads = 0
    let promptReads = 0
    const spy = vi
      .spyOn(queueRequests, 'structuredAgentSessionSendQueues')
      .mockImplementation((...args) => {
        resolving = true
        try {
          return original(...args)
        } finally {
          resolving = false
        }
      })
    const body = {
      kind: 'approval',
      title: 'Review',
      detail: null,
      subject: { kind: 'diff' },
      options: [{ id: 'allow', label: 'Approve' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    }
    if (!isAdmissibleAgentJournalItemBody(body)) {
      throw new Error('Invalid approval fixture')
    }
    const previous = { readItems, readQueued, currentRequests }
    try {
      setLocalRuntimeCapabilitiesForTests([AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY])
      readItems = [
        {
          itemId: 'perf-turn',
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'turn', turnId: 'perf-provider-turn', state: 'running' }
        }
      ]
      readQueued = Array.from({ length: size }, (_, index) => ({
        messageId: `perf-${index}`,
        position: index,
        get state() {
          if (resolving) {
            queueReads++
          }
          return 'waiting' as const
        },
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] }
      }))
      currentRequests = Array.from({ length: size }, (_, index) => ({
        itemId: `prompt-${index}`,
        revision: 1,
        sequence: index,
        observedAt: 1,
        get body() {
          if (resolving) {
            promptReads++
          }
          return body
        }
      }))
      const mounted = renderHook(
        ({ followUpsQueue }) =>
          useStructuredAgentSession({
            sessionId: 'presentation-perf',
            target: { kind: 'local' },
            agent: 'codex',
            isVisible: true,
            queueFollowUps: followUpsQueue
          }),
        { initialProps: { followUpsQueue: true } }
      )
      await act(async () => {})
      for (const followUpsQueue of [true, false]) {
        await act(async () => mounted.rerender({ followUpsQueue }))
        queueReads = 0
        promptReads = 0
        spy.mockClear()
        readItems = [
          ...readItems,
          {
            itemId: `journal-${followUpsQueue}`,
            revision: 1,
            sequence: size + 1,
            observedAt: 2,
            body: { kind: 'status', text: 'Working' }
          }
        ]
        await act(async () => mounted.rerender({ followUpsQueue }))
        expect(spy).toHaveBeenCalledTimes(3)
        expect(queueReads).toBe(size * (followUpsQueue ? 1 : 2))
        expect(promptReads).toBe(size * (followUpsQueue ? 2 : 1))
        expect(mounted.result.current.sendFollowUp).toEqual({
          action: 'steer',
          offersChoice: false
        })
      }
      mounted.unmount()
    } finally {
      spy.mockRestore()
      ;({ readItems, readQueued, currentRequests } = previous)
      setLocalRuntimeCapabilitiesForTests(null)
    }
  }
)
