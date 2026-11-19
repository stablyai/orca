// @vitest-environment happy-dom
import { act } from 'react'

import { resetStructuredAgentSessionSendsForTests } from '../session/structured/delivery/structured-agent-session-message-sender'
const rpc = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../../../runtime/native-chat/requests/structured-agent-session-call', () => ({
  callStructuredAgentSession: rpc.call
}))
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import { nativeChatPromptDismissals } from './native-chat-prompt-dismissals'
import type { AgentJournalSubmission } from '../../../../../shared/agent-session/journal/agent-session-journal-types'

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

describe('async question send ownership', () => {
  it('keeps an answer locked when its queue card is replaced by a pending handoff', () => {
    let recorded: (() => void) | undefined
    const send = vi.fn<NativeChatStructuredComposerTransport['send']>((_text, _images, request) => {
      request?.onCreated?.('card')
      recorded = () => request?.onSettled?.('recorded')
      return true
    })
    const render = (
      queuedCards: { text: string }[] = [],
      submissions: AgentJournalSubmission[] = [],
      messages = [asked]
    ) =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="scope"
            sourceKey="host/epoch"
            sourceScope="host/epoch"
            session={{ messages, readPhase: 'ready' }}
            queuedCards={queuedCards}
            submissions={submissions}
            send={send}
          />
        )
      )
    const option = () => container.querySelector<HTMLButtonElement>('button[aria-pressed]')
    const text = '> Which color?\n\nRed'
    render()
    act(() => option()!.click())
    act(() => vi.runOnlyPendingTimers())
    render([{ text }])
    expect(option()).toBeNull()
    act(() => recorded!())

    const handoff = { ...pendingAnswer, queuedMessageId: 'card' }
    render([], [handoff])
    expect(option()?.disabled).toBe(true)

    const rejected = { ...handoff, dispatchState: 'rejected' as const }
    render([], [rejected])
    expect(option()?.disabled).toBe(false)

    render([], [rejected, { ...handoff, clientMessageId: 'retry', submittedAt: 3 }])
    expect(option()?.disabled).toBe(true)

    render(
      [],
      [{ ...handoff, dispatchState: 'accepted' }],
      [
        asked,
        {
          id: 'orca:answer',
          role: 'user',
          timestamp: 3,
          source: 'transcript',
          blocks: [{ type: 'text', text }]
        }
      ]
    )
    expect(option()).toBeNull()
  })

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
        .find((node) => node.textContent?.startsWith('Submit'))!
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
  it('submits with Enter on the chosen option even though the async card does not take focus', () => {
    const send = vi.fn<NativeChatStructuredComposerTransport['send']>((_text, _images, request) => {
      request?.onCreated?.(send.mock.calls.length === 1 ? 'answer' : 'retry')
      return true
    })
    const render = (submissions: AgentJournalSubmission[] = []) =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="scope"
            sourceKey="host/epoch"
            sourceScope="host/epoch"
            session={{ messages: [asked], readPhase: 'ready' }}
            submissions={submissions}
            send={send}
          />
        )
      )
    const blue = () =>
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-pressed]')].find((node) =>
        node.textContent?.includes('Blue')
      )!
    render()
    act(() => blue().dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => vi.advanceTimersByTime(200))
    expect(send).toHaveBeenCalledTimes(1)
    // The first delivery is uncertain, so the card comes back with Blue still chosen.
    render([{ ...pendingAnswer, dispatchState: 'unknown' }])
    expect(blue().getAttribute('aria-pressed')).toBe('true')
    // A real keyboard user can reach the row: it is enabled and holds focus.
    expect(blue().disabled).toBe(false)
    act(() => blue().focus())
    expect(document.activeElement).toBe(blue())
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    act(() => {
      blue().dispatchEvent(enter)
    })
    // Enter submits like the footer's Submit; it neither deselects nor lets the native click run.
    expect(enter.defaultPrevented).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(blue().getAttribute('aria-pressed')).toBe('true')
  })
})

describe('async question older than the loaded messages', () => {
  it('shows the question the host waits on, Skips it by its row, and drops it once the person replies', () => {
    const save = vi.fn(() => Promise.resolve())
    const notice: NativeChatMessage = {
      id: 'notice',
      role: 'user',
      from: { kind: 'agent', senders: [], orchestration: null },
      timestamp: 4,
      source: 'transcript',
      blocks: [{ type: 'text', text: 'Update from worker' }]
    }
    const render = (messages: NativeChatMessage[]) =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="scope"
            sourceKey="host/epoch"
            sourceScope="host/epoch"
            session={{ messages, readPhase: 'ready' }}
            skip={{
              skippedThrough: undefined,
              awaiting: { itemId: 'old-ask', text: 'File the follow-up?' },
              save
            }}
            send={vi.fn(() => true)}
          />
        )
      )
    render([notice])
    expect(container.textContent).toContain('File the follow-up?')
    const skip = [...container.querySelectorAll('button')].find(
      (node) => node.textContent === 'Skip'
    )!
    act(() => skip.click())
    expect(save).toHaveBeenCalledWith('old-ask')

    nativeChatPromptDismissals.clearForTests()
    render([
      notice,
      {
        id: 'reply',
        role: 'user',
        timestamp: 5,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'No' }]
      }
    ])
    expect(container.textContent).not.toContain('File the follow-up?')
  })
})
