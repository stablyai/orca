// @vitest-environment happy-dom
import { act, useLayoutEffect } from 'react'
import type * as QuestionCard from './NativeChatQuestionCard'
import type { NativeChatQuestionCardProps } from './NativeChatQuestionCard'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { fireEvent, within } from '@testing-library/react'
import { NativeChatViewIdentity, retireNativeChatViewState } from './native-chat-view-state-memory'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import { recordedCodexAsyncMessages } from '../../../../shared/__fixtures__/codex-0163-async-question'

const card = vi.hoisted<{ current: NativeChatQuestionCardProps | null }>(() => ({ current: null }))
vi.mock('./NativeChatQuestionCard', async (original) => {
  const actual = await original<typeof QuestionCard>()
  return {
    ...actual,
    NativeChatQuestionCard: (props: NativeChatQuestionCardProps) => {
      useLayoutEffect(() => {
        card.current = props
      })
      return <actual.NativeChatQuestionCard {...props} />
    }
  }
})

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
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

describe('NativeChatStructuredAsyncQuestion', () => {
  it('answers a Codex async question with an ordinary send, then hides it', () => {
    const send = vi.fn(() => true)
    act(() =>
      root.render(
        <NativeChatStructuredAsyncQuestion
          session={{ messages: [asked], readPhase: 'ready' }}
          send={send}
        />
      )
    )
    const blue = [...container.querySelectorAll('button[aria-pressed]')].find((node) =>
      node.textContent?.includes('Blue')
    )
    act(() => blue?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    act(() => vi.runAllTimers())

    expect(send).toHaveBeenCalledWith('> Which color?\n\nBlue', [])
    expect(container.textContent).not.toContain('Which color?')
  })
})

const occurrence = (
  id: string,
  sequence: number,
  callId = 'reused',
  title = 'Which color?'
): NativeChatMessage => ({
  ...asked,
  id,
  journalPosition: { sequence, index: 0 },
  blocks: [
    {
      type: 'tool-call',
      name: 'request_user_input_async',
      callId,
      input: { questions: [{ title, options: ['Red', 'Blue'] }] }
    }
  ]
})
const delivered: NativeChatMessage = {
  ...asked,
  id: 'phone',
  role: 'user',
  journalPosition: { sequence: 2, index: 0 },
  blocks: [{ type: 'text', text: 'Red' }]
}

it('distinguishes a later identical occurrence after park and delivered answer, including a reused provider call id', () => {
  const send = vi.fn(() => true)
  const key = 'async-occurrence'
  const show = (messages: NativeChatMessage[], ready = true) =>
    act(() =>
      root.render(
        <NativeChatViewIdentity value={key}>
          <NativeChatStructuredAsyncQuestion
            epoch="e"
            session={{ messages, readPhase: ready ? 'ready' : 'loading' }}
            send={send}
          />
        </NativeChatViewIdentity>
      )
    )
  show([occurrence('first', 1)])
  fireEvent.click(within(container).getByRole('button', { name: 'Cancel' }))
  expect(container.textContent).not.toContain('Which color?')
  act(() => root.render(null))
  show([], false)
  show([occurrence('first', 1)])
  expect(container.textContent).not.toContain('Which color?')
  act(() => root.render(null))
  show([occurrence('first', 1), delivered, occurrence('second', 3)])
  fireEvent.click(within(container).getByRole('button', { name: /Blue/ }))
  act(() => vi.runAllTimers())
  expect(send).toHaveBeenCalledTimes(1)
  expect(send).toHaveBeenLastCalledWith('> Which color?\n\nBlue', [])
  expect(container.textContent).not.toContain('Which color?')
  retireNativeChatViewState(key)
})

it('keeps same-occurrence choices through unknown and park, preserves rejected sends, and retires incompatible full content', () => {
  const key = 'async-progress'
  const send = vi.fn(() => false)
  const prompt: NativeChatMessage = {
    ...occurrence('one', 1),
    blocks: [
      {
        type: 'tool-call',
        name: 'request_user_input_async',
        input: {
          questions: [{ title: `${'x'.repeat(210)}A`, multiSelect: true, options: ['Red', 'Blue'] }]
        }
      }
    ]
  }
  const show = (messages: NativeChatMessage[], ready = true) =>
    act(() =>
      root.render(
        <NativeChatViewIdentity value={key}>
          <NativeChatStructuredAsyncQuestion
            epoch="e"
            session={{ messages, readPhase: ready ? 'ready' : 'loading' }}
            send={send}
          />
        </NativeChatViewIdentity>
      )
    )
  show([prompt])
  fireEvent.click(within(container).getByRole('button', { name: /Blue/ }))
  act(() => root.render(null))
  show([], false)
  expect(container.querySelector('button')).toBeNull()
  show([prompt])
  expect(within(container).getByRole('button', { name: /Blue/ }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  fireEvent.click(within(container).getByRole('button', { name: /Submit|Send|Confirm/ }))
  expect(send).toHaveBeenCalledTimes(1)
  expect(within(container).getByRole('button', { name: /Blue/ }).getAttribute('aria-pressed')).toBe(
    'true'
  )
  const corrected = {
    ...prompt,
    blocks: [
      {
        type: 'tool-call' as const,
        name: 'request_user_input_async',
        input: {
          questions: [{ title: `${'x'.repeat(210)}B`, multiSelect: true, options: ['Red', 'Blue'] }]
        }
      }
    ]
  }
  show([corrected])
  expect(within(container).getByRole('button', { name: /Blue/ }).getAttribute('aria-pressed')).toBe(
    'false'
  )
  retireNativeChatViewState(key)
})

it('rejects stale answer/cancel callbacks and disposes auto-advance before a successor or retired view can send', () => {
  const key = 'async-current-callback'
  const send = vi.fn(() => true)
  const show = (message: NativeChatMessage) =>
    act(() =>
      root.render(
        <NativeChatViewIdentity value={key}>
          <NativeChatStructuredAsyncQuestion
            epoch="e"
            session={{ messages: [message], readPhase: 'ready' }}
            send={send}
          />
        </NativeChatViewIdentity>
      )
    )
  show(occurrence('first', 1))
  const old = card.current!
  fireEvent.click(within(container).getByRole('button', { name: /Blue/ }))
  show(occurrence('second', 3))
  act(() => {
    old.onAnswer([{ indices: [1] }])
    old.onCancel()
    vi.runAllTimers()
  })
  expect(send).not.toHaveBeenCalled()
  expect(container.textContent).toContain('Which color?')
  const current = card.current!
  retireNativeChatViewState(key)
  act(() => current.onAnswer([{ indices: [1] }]))
  expect(send).not.toHaveBeenCalled()
})

it('keeps the recorded Codex async occurrence pending after early tool acceptance, with current card progress across park', () => {
  const messages = recordedCodexAsyncMessages
  const key = 'recorded-codex-async'
  const send = vi.fn(() => true)
  const show = (rows: NativeChatMessage[]) =>
    act(() =>
      root.render(
        <NativeChatViewIdentity value={key}>
          <NativeChatStructuredAsyncQuestion
            epoch="recorded-epoch"
            session={{ messages: rows, readPhase: 'ready' }}
            send={send}
          />
        </NativeChatViewIdentity>
      )
    )
  show(messages.slice(0, 1))
  expect(within(container).getByRole('group', { name: 'Which should I summarize?' })).toBeTruthy()
  fireEvent.click(within(container).getByRole('button', { name: /Summarize this request/ }))
  const beforePark = card.current
  if (beforePark === null) {
    throw new Error('Question card did not commit')
  }
  act(() => root.render(null))
  act(() => vi.runAllTimers())
  expect(send).not.toHaveBeenCalled()
  show(messages)
  act(() => {
    beforePark.onAnswer([{ indices: [0] }])
    beforePark.onCancel()
    vi.runAllTimers()
  })
  expect(send).not.toHaveBeenCalled()
  expect(
    within(container)
      .getByRole('button', { name: /Summarize this request/ })
      .getAttribute('aria-pressed')
  ).toBe('true')
  fireEvent.click(within(container).getByRole('button', { name: 'Submit' }))
  expect(send).toHaveBeenCalledExactlyOnceWith(
    '> Which should I summarize?\n\nSummarize this request',
    []
  )
  expect(container.textContent).not.toContain('Which should I summarize?')
  act(() => root.render(null))
  show(messages)
  expect(container.textContent).not.toContain('Which should I summarize?')
  expect(send).toHaveBeenCalledTimes(1)
  retireNativeChatViewState(key)
})
