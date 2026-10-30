// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { asyncQuestionSourceScope } from '../../../../shared/native-chat/input/native-chat-ask'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredItemToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatStructuredAsyncQuestion } from './NativeChatStructuredAsyncQuestion'
import { useNativeChatAsyncQuestions } from './use-native-chat-async-questions'
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
  it.each([true, false])(
    'keeps an async answer through agent mail (send accepted: %s)',
    (accepted) => {
      const send = vi.fn(() => accepted)
      const render = (messages: NativeChatMessage[]): void =>
        act(() =>
          root.render(
            <NativeChatStructuredAsyncQuestion
              paneKey="tab-1:structured"
              sourceScope="journal/session/epoch"
              sourceKey="journal/host/session/epoch"
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
      expect(container.textContent).toContain('Which color?')
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
              sourceScope="journal/session/epoch"
              sourceKey="journal/host/session/epoch"
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
      expect(container.textContent).toContain('Which color?')

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
  it('keeps cancelled contributors hidden across edits, new siblings, paging and blocking', () => {
    const send = vi.fn(() => true)
    const render = (
      messages: NativeChatMessage[],
      blocked = false,
      sourceKey = 'journal/host/session/epoch'
    ) =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="tab-1:structured"
            sourceScope={sourceKey}
            sourceKey={sourceKey}
            session={{ messages, readPhase: 'ready' }}
            blocked={blocked}
            send={send}
          />
        )
      )
    const cancel = () =>
      act(() =>
        container
          .querySelector('button[aria-label="Cancel"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
    render([asked])
    cancel()
    const edited = {
      ...asked,
      blocks: [
        {
          type: 'tool-call' as const,
          name: 'request_user_input_async',
          input: { questions: [{ title: 'Edited Q1?' }] }
        }
      ]
    }
    const sibling = {
      type: 'tool-call' as const,
      name: 'request_user_input_async',
      input: { questions: [{ title: 'Q2?' }] }
    }
    render([{ ...edited, blocks: [...edited.blocks, sibling] }])
    expect(container.textContent).toContain('Q2?')
    expect(container.textContent).not.toContain('Edited Q1?')
    cancel()
    render([])
    render([asked], true)
    render([{ ...edited, blocks: [...edited.blocks, sibling] }])
    expect(container.textContent).toBe('')
    render([asked, { ...asked, id: 'new-equal-text-row' }])
    expect(container.textContent).toContain('Which color?')
    cancel()
    expect(send).not.toHaveBeenCalled()
    render([asked], false, 'journal/host/session/reset')
    expect(container.textContent).toContain('Which color?')
  })

  it('resets pending selections when a definition changes without cancelling it', () => {
    const send = vi.fn(() => true)
    const render = (title: string, option: string) =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="tab-1:structured"
            sourceScope="journal/session/epoch"
            sourceKey="journal/host/session/epoch"
            session={{
              readPhase: 'ready',
              messages: [
                {
                  ...asked,
                  blocks: [
                    {
                      type: 'tool-call',
                      name: 'request_user_input_async',
                      input: { questions: [{ title, options: [option, 'Blue'] }] }
                    }
                  ]
                }
              ]
            }}
            send={send}
          />
        )
      )
    render('Q1?', 'Red')
    const red = [...container.querySelectorAll('button[aria-pressed]')].find((node) =>
      node.textContent?.includes('Red')
    )!
    act(() => red.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(red.getAttribute('aria-pressed')).toBe('true')
    render('Revised Q1?', 'Green')
    expect(container.textContent).toContain('Revised Q1?')
    expect([...container.querySelectorAll('button[aria-pressed="true"]')]).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('isolates addressed hide subscriptions and reuses the scan at N/10N panes', () => {
    for (const count of [8, 80]) {
      let scans = 0
      const messages = [
        {
          ...asked,
          get blocks() {
            scans += 1
            return asked.blocks
          }
        }
      ]
      const renders = Array<number>(count).fill(0)
      const actions: (() => void)[] = []
      function Probe({ index }: { index: number }): null {
        renders[index] = (renders[index] ?? 0) + 1
        const projection = useNativeChatAsyncQuestions({
          paneKey: `pane-${count}-${index}`,
          sourceKey: `host-${index % 2}/session-${Math.floor(index / 2)}/epoch`,
          sourceScope: asyncQuestionSourceScope({
            kind: 'journal',
            agent: 'codex',
            sessionId: `session-${Math.floor(index / 2)}`,
            epoch: 'epoch'
          }),
          viewKey: 'pty',
          messages,
          settled: true
        })
        actions[index] = projection.dismiss
        return null
      }
      act(() =>
        root.render(
          <>
            {Array.from({ length: count }, (_, index) => (
              <Probe key={index} index={index} />
            ))}
          </>
        )
      )
      const initialScans = scans
      expect(initialScans).toBeGreaterThanOrEqual(count)
      expect(initialScans).toBeLessThanOrEqual(2 * count)
      renders.fill(0)
      act(() => actions[0]!())
      expect(renders).toEqual([1, ...Array<number>(count - 1).fill(0)])
      expect(scans).toBe(initialScans)
      renders.fill(0)
      act(() => actions[1]!())
      expect(renders).toEqual([0, 1, ...Array<number>(count - 2).fill(0)])
      expect(scans).toBe(initialScans)
      renders.fill(0)
      act(() => actions[0]!())
      expect(renders.every((value) => value === 0)).toBe(true)
      act(() => root.render(null))
    }
  })

  it('preserves later same-ID Cancel through eviction without depending on answer settlement', () => {
    let settle = () => {}
    const send = vi.fn<NativeChatStructuredComposerTransport['send']>((_text, _images, request) => {
      settle = () => request?.onSettled?.('unconfirmed')
      return 'queued'
    })
    const render = () =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="tab-1:structured"
            sourceKey="journal/host/session/epoch"
            sourceScope="journal/session/epoch"
            session={{ messages: [asked], readPhase: 'ready' }}
            send={send}
          />
        )
      )
    render()
    act(() =>
      [...container.querySelectorAll('button[aria-pressed]')]
        .find((node) => node.textContent?.includes('Blue'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    act(() => vi.runAllTimers())
    expect(container.textContent).toContain('Which color?')
    act(() => {
      for (let index = 0; index < 128; index += 1) {
        nativeChatPromptDismissals.hideAsync(`other-${index}`, ['other'])
      }
    })
    act(() =>
      container
        .querySelector('button[aria-label="Cancel"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    act(settle)
    render()
    expect(container.textContent).not.toContain('Which color?')
    expect(send).toHaveBeenCalledWith('> Which color?\n\nBlue', [])
  })

  it.each([false, true, 'queued'] as const)(
    'does not make %s admission a retained hide',
    (admission) => {
      const send = vi.fn<NativeChatStructuredComposerTransport['send']>(() => admission)
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="tab-1:structured"
            sourceKey="host"
            sourceScope="journal/session/epoch"
            session={{ messages: [asked], readPhase: 'ready' }}
            send={send}
          />
        )
      )
      act(() =>
        [...container.querySelectorAll('button[aria-pressed]')]
          .find((node) => node.textContent?.includes('Blue'))!
          .dispatchEvent(new MouseEvent('click', { bubbles: true }))
      )
      act(() => vi.runAllTimers())
      expect(container.textContent).toContain('Which color?')
    }
  )
  it('resets pending choices when host ownership changes with the same portable definition', () => {
    const send = vi.fn(() => true)
    const render = (host: string) =>
      act(() =>
        root.render(
          <NativeChatStructuredAsyncQuestion
            paneKey="same-pane"
            sourceKey={host}
            sourceScope="same-portable-source"
            session={{ messages: [asked], readPhase: 'ready' }}
            send={send}
          />
        )
      )
    render('host-A')
    act(() =>
      [...container.querySelectorAll('button[aria-pressed]')]
        .find((node) => node.textContent?.includes('Blue'))!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }))
    )
    expect(container.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(1)
    render('host-B')
    expect(container.querySelectorAll('button[aria-pressed="true"]')).toHaveLength(0)
    act(() => vi.runAllTimers())
    expect(send).not.toHaveBeenCalled()
  })
})
