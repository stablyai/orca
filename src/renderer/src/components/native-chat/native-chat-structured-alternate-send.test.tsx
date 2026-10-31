// @vitest-environment happy-dom

// Enter and Cmd/Ctrl+Enter reach the outgoing agentSession.send through the real composer, transport and session.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

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

vi.mock('./use-structured-agent-session-read', () => ({
  useStructuredAgentSessionRead: () => ({
    state: {
      fence: 3,
      items: [RUNNING_TURN],
      submissions: [],
      status: 'ready',
      error: null,
      hasOlder: false,
      queuedMessages: [],
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
vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))

import {
  AGENT_SESSION_CONVERSATION_STOP_RUNTIME_CAPABILITY,
  AGENT_SESSION_QUEUED_MESSAGES_RUNTIME_CAPABILITY
} from '../../../../shared/protocol-version'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/local-runtime-capabilities'
import { TooltipProvider } from '@/components/ui/tooltip'
import { NativeChatComposer } from './NativeChatComposer'
import { useStructuredAgentSession } from './use-structured-agent-session'
import { useNativeChatStructuredComposerTransport } from './use-native-chat-structured-composer-transport'
import { nativeChatStructuredStopControls } from './native-chat-structured-stop-controls'
import { changePrompt } from './native-chat-prompt-editor.test-support'

function Chat({ queueFollowUps }: { queueFollowUps: boolean }): React.JSX.Element {
  const props = { agent: 'claude', sessionId: 'session-1', target: { kind: 'local' } } as const
  const controller = useStructuredAgentSession({
    ...props,
    isVisible: true,
    composerScopeKey: `alternate-send-${queueFollowUps}`,
    queueFollowUps
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

afterEach(() => {
  cleanup()
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
})
