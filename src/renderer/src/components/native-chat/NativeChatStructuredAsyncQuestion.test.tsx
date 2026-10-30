// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'

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
  it.each([true, false])(
    'keeps an async answer through agent mail (send accepted: %s)',
    (accepted) => {
      const send = vi.fn(() => accepted)
      const render = (messages: NativeChatMessage[]): void =>
        act(() =>
          root.render(
            <NativeChatStructuredAsyncQuestion
              paneKey="tab-1:structured"
              session={{ messages, readPhase: 'ready' }}
              send={send}
            />
          )
        )
      render([asked])
      const input = container.querySelector<HTMLInputElement>(
        'input[data-native-chat-answer-field]'
      )!
      act(() => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
        setter.call(input, 'Green')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const blue = [...container.querySelectorAll('button[aria-pressed]')].find((node) =>
        node.textContent?.includes('Blue')
      )
      act(() => blue?.dispatchEvent(new MouseEvent('click', { bubbles: true })))
      const notice = projectStructuredItemToNativeChat({
        itemId: 'orca:submission:mail',
        sequence: 2,
        revision: 0,
        observedAt: 2,
        body: {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'You have 1 orchestration message.' }],
          from: {
            kind: 'agent',
            senders: [
              {
                party: { address: 'term_a', terminalHandle: 'term_a', orcaSessionId: null },
                name: 'Coder'
              }
            ],
            orchestration: {
              message: 'mail-notice',
              mailbox: 'term_b',
              dispatchId: null,
              messages: [{ messageId: 'mail-1', runId: 'run-1', from: 'term_a' }]
            }
          }
        }
      })!
      expect(notice.from?.kind).toBe('agent')
      render([asked, notice])
      expect(container.textContent).toContain('Which color?')
      expect(
        [...container.querySelectorAll('button[aria-pressed]')].map((node) => node.textContent)
      ).toEqual(
        expect.arrayContaining([expect.stringContaining('Red'), expect.stringContaining('Blue')])
      )
      expect(container.querySelector('button[aria-pressed="true"]')?.textContent).toContain('Blue')
      expect(
        container.querySelector<HTMLInputElement>('input[data-native-chat-answer-field]')?.value
      ).toBe('Green')
      act(() => vi.runAllTimers())

      expect(send).toHaveBeenCalledWith('> Which color?\n\nBlue', [])
      expect(container.textContent?.includes('Which color?')).toBe(!accepted)
      render([
        asked,
        notice,
        {
          id: 'human-answer',
          role: 'user',
          blocks: [{ type: 'text', text: 'Blue' }],
          timestamp: 3,
          source: 'transcript'
        }
      ])
      expect(container.textContent).not.toContain('Which color?')
    }
  )
})
