// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import { nativeChatPromptDismissals } from './native-chat-prompt-dismissals'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  nativeChatPromptDismissals.clearForTests()
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
          paneKey="tab-1:structured"
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

  it.each([undefined, 'reused-call'])(
    'shows an identical replacement in one ready-to-ready update (call ID: %s)',
    (callId) => {
      const send = vi.fn(() => true)
      const first = {
        ...asked,
        blocks: asked.blocks.map((block) =>
          block.type === 'tool-call' ? { ...block, callId } : block
        )
      }
      const render = (messages: NativeChatMessage[]) =>
        act(() =>
          root.render(
            <NativeChatStructuredAsyncQuestion
              paneKey="tab-1:structured"
              session={{ messages, readPhase: 'ready' }}
              send={send}
            />
          )
        )
      render([first])
      act(() =>
        container
          .querySelector('button[aria-label="Cancel"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
      expect(container.textContent).not.toContain('Which color?')
      expect(send).not.toHaveBeenCalled()
      // Same canonical row stays dismissed through renamed/removed IDs and block reshaping.
      for (const readbackId of ['resumed-call', undefined]) {
        render([
          {
            ...first,
            blocks: [
              { type: 'text', text: 'More context' },
              ...first.blocks.map((block) =>
                block.type === 'tool-call' ? { ...block, callId: readbackId } : block
              )
            ]
          }
        ])
        expect(container.textContent).not.toContain('Which color?')
      }

      const answer: NativeChatMessage = {
        id: 'delivered-answer',
        role: 'user',
        blocks: [{ type: 'text', text: 'Blue' }],
        timestamp: null,
        source: 'transcript'
      }
      render([first, answer, { ...first, id: 'ask-again' }])
      expect(container.textContent).toContain('Which color?')
      const blue = [...container.querySelectorAll('button[aria-pressed]')].find((node) =>
        node.textContent?.includes('Blue')
      )
      act(() => blue?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      act(() => vi.runAllTimers())
      expect(send).toHaveBeenCalledWith('> Which color?\n\nBlue', [])
      expect(container.textContent).not.toContain('Which color?')

      render([
        first,
        answer,
        { ...first, id: 'ask-again' },
        { ...answer, id: 'second-answer' },
        { ...first, id: 'third-ask' }
      ])
      expect(container.textContent).toContain('Which color?')
    }
  )
})

it('renders authoritative choices and free text without a question in loaded history, and Cancel sends nothing', () => {
  const prompt = {
    replyAsMessage: true as const,
    occurrenceKey: '["source-row"]',
    questions: [
      {
        question: 'Which color?',
        multiSelect: false,
        options: [{ label: 'Red' }, { label: 'Blue' }]
      }
    ]
  }
  const send = vi.fn(() => true)
  const render = (asyncQuestion: typeof prompt | null) =>
    act(() =>
      root.render(
        <NativeChatStructuredAsyncQuestion
          paneKey="host-current"
          session={{ messages: [], readPhase: 'ready', asyncQuestion }}
          send={send}
        />
      )
    )
  render(prompt)
  expect(container.textContent).toContain('Which color?')
  expect(container.querySelector('textarea, input')).not.toBeNull()
  act(() =>
    container
      .querySelector('button[aria-label="Cancel"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  )
  expect(send).not.toHaveBeenCalled()
  render({ ...prompt, occurrenceKey: '["later-row"]' })
  const blue = [...container.querySelectorAll('button[aria-pressed]')].find((node) =>
    node.textContent?.includes('Blue')
  )
  act(() => blue?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  act(() => vi.runAllTimers())
  expect(send).toHaveBeenCalledWith('> Which color?\n\nBlue', [])
  render(null)
  expect(container.textContent).not.toContain('Which color?')
})
