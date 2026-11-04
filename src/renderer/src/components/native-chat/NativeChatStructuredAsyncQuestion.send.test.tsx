// @vitest-environment happy-dom
import { act } from 'react'
import { useStructuredAgentSessionSends } from './use-structured-agent-session-sends'
import { resetStructuredAgentSessionSendsForTests } from './structured-agent-session-message-sender'
const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc.call
}))
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import { nativeChatPromptDismissals } from './native-chat-prompt-dismissals'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  nativeChatPromptDismissals.clearForTests()
  rpc.call.mockReset()
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  resetStructuredAgentSessionSendsForTests()
  container.remove()
  vi.useRealTimers()
})

const asked: NativeChatMessage = {
  id: 'ask',
  role: 'assistant',
  blocks: [
    { type: 'text', text: 'Which color?\n- Red\n- Blue' },
    {
      type: 'tool-call',
      name: 'request_user_input_async',
      input: { questions: [{ title: 'Which color?', options: ['Red', 'Blue'] }] }
    }
  ],
  timestamp: null,
  source: 'transcript'
}

const askedItem: AgentJournalRenderItem = {
  itemId: asked.id,
  sequence: 1,
  revision: 0,
  observedAt: 1,
  body: { kind: 'message', role: 'assistant', blocks: asked.blocks }
}
const answerItem = {
  ...askedItem,
  itemId: agentJournalSubmissionKey('answer'),
  sequence: 2,
  body: {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: '> Which color?\n\nBlue' }]
  }
} satisfies AgentJournalRenderItem
const pendingAnswer: AgentJournalSubmission = {
  clientMessageId: 'answer',
  fence: 1,
  payloadFingerprint: 'answer',
  dispatchState: 'pending',
  providerItemId: null,
  reason: null,
  submittedAt: 2,
  resolvedAt: null,
  handoverRecorded: true
}

const NO_SUBMISSIONS: AgentJournalSubmission[] = []
const INITIAL_ITEMS = [askedItem]

describe('async question send ownership', () => {
  it.each(['publication', 'read'] as const)(
    'bridges its actual sender through RPC-first echo until %s coverage',
    async (coverage) => {
      let reply = (_value: unknown) => {}
      rpc.call.mockImplementation(
        () =>
          new Promise((resolve) => {
            reply = resolve
          })
      )
      let pending: readonly { clientMessageId: string }[] = []
      const target = { kind: 'local' } as const
      const queue = {
        capability: 'unsupported',
        followUpsQueue: false,
        isWorking: false,
        stopping: false,
        session: { queuedMessages: [] },
        prompts: []
      } as const
      function Chat({
        submissions = NO_SUBMISSIONS,
        cursor,
        items = INITIAL_ITEMS
      }: {
        submissions?: AgentJournalSubmission[]
        cursor?: { epoch: string; sequence: number }
        items?: AgentJournalRenderItem[]
      }) {
        const sends = useStructuredAgentSessionSends({
          sessionId: 'answer-session',
          target,
          fence: 1,
          submissions,
          queuedMessageIds: [],
          queue,
          historyLoaded: false,
          isWorking: false,
          cursor
        })
        pending = sends.pending
        return (
          <NativeChatStructuredAsyncQuestion
            paneKey="answer-session"
            sourceKey="host/epoch"
            sourceScope="host/epoch"
            session={{
              messages: projectStructuredAgentSessionMessages(items, sends.pending, submissions),
              readPhase: 'ready'
            }}
            submissions={submissions}
            send={(text, _attachments, request) => sends.send(text, [], request)}
          />
        )
      }
      act(() => root.render(<Chat />))
      act(() =>
        [...container.querySelectorAll('button[aria-pressed]')]
          .find((node) => node.textContent?.includes('Blue'))!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      const selected = container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!
      expect(selected.disabled).toBe(true)
      const id = pending[0]!.clientMessageId
      const submission = { ...pendingAnswer, clientMessageId: id }
      await act(async () =>
        reply({
          ok: true,
          replayed: false,
          fence: 1,
          cursor: { epoch: 'epoch', sequence: 2 },
          value: { clientMessageId: id, submission }
        })
      )
      expect(pending).toHaveLength(1)
      expect(container.querySelector('button[aria-pressed="true"]')).toBe(selected)
      expect(selected.disabled).toBe(true)
      if (coverage === 'publication') {
        act(() =>
          root.render(
            <Chat
              submissions={[submission]}
              items={[askedItem, { ...answerItem, itemId: agentJournalSubmissionKey(id) }]}
            />
          )
        )
        expect(selected.disabled).toBe(true)
        act(() =>
          root.render(
            <Chat
              submissions={[{ ...submission, dispatchState: 'unknown' }]}
              items={[askedItem, { ...answerItem, itemId: agentJournalSubmissionKey(id) }]}
            />
          )
        )
      } else {
        act(() => root.render(<Chat cursor={{ epoch: 'epoch', sequence: 2 }} />))
      }
      expect(pending).toHaveLength(0)
      expect(container.querySelector('button[aria-pressed="true"]')).toBe(selected)
      expect(selected.disabled).toBe(false)
    }
  )

  it('releases journal-first uncertainty before a late callback, fences retries and resets ownership on revised forms and sources', () => {
    const completions: (() => void)[] = []
    const send = vi.fn<NativeChatStructuredComposerTransport['send']>((_text, _images, request) => {
      request?.onCreated?.(completions.length === 0 ? 'answer' : 'retry')
      completions.push(() => request?.onSettled?.('recorded'))
      return true
    })
    const render = (
      messages = [asked],
      submissions: AgentJournalSubmission[] = [],
      sourceKey = 'host/epoch'
    ) =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="scope"
            sourceKey={sourceKey}
            sourceScope={sourceKey}
            session={{ messages, readPhase: 'ready' }}
            submissions={submissions}
            send={send}
          />
        )
      )
    const pick = () => {
      act(() =>
        [...container.querySelectorAll('button[aria-pressed]')]
          .find((node) => node.textContent?.includes('Blue'))!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
      act(() => vi.advanceTimersByTime(200))
    }
    render()
    pick()
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!.disabled
    ).toBe(true)
    render([asked], [{ ...pendingAnswer, dispatchState: 'unknown' }])
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!.disabled
    ).toBe(false)
    act(() =>
      [...container.querySelectorAll('button')]
        .find((node) => node.textContent === 'Submit')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    act(() => completions[0]!())
    expect(
      container.querySelector<HTMLButtonElement>('button[aria-pressed="true"]')!.disabled
    ).toBe(true)
    const revised = {
      ...asked,
      blocks: asked.blocks.map((block) =>
        block.type === 'tool-call'
          ? { ...block, input: { questions: [{ title: 'New choice?', options: ['Red', 'Blue'] }] } }
          : block
      )
    }
    render([revised])
    expect(container.querySelector('button[aria-pressed="true"]')).toBeNull()
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].every(
        (node) => !node.disabled
      )
    ).toBe(true)
    pick()
    render([revised], [], 'other-host/epoch-2')
    act(() => completions[1]!())
    expect(
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].every(
        (node) => !node.disabled
      )
    ).toBe(true)
  })
})
