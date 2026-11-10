// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'

import { NativeChatToolRun } from './NativeChatToolRun'

import { openToolRunMembers } from './native-chat-tool-run-members-test-support'

import {
  MAX_NATIVE_CHAT_DISCLOSURES,
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../../messages/disclosure/native-chat-disclosure-store'

{
  const QUESTION = 'What would you like me to do next in this repo?'
  const ASK_INPUT = { questions: [{ question: QUESTION }] }

  function askBlocks(state: 'running' | 'completed'): NativeChatBlock[] {
    return [{ type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state }]
  }

  /** Lays every element out wider than its box, as a long question is on its line. */
  function clipEveryLine(): () => void {
    const originals = ['scrollWidth', 'clientWidth'].map(
      (name) => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as const
    )
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
      configurable: true,
      get: () => 400
    })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => 100
    })
    return () => {
      for (const [name, original] of originals) {
        if (original) {
          Object.defineProperty(HTMLElement.prototype, name, original)
        } else {
          Reflect.deleteProperty(HTMLElement.prototype, name)
        }
      }
    }
  }

  function DisclosureHarness({ mounted }: { mounted: boolean }): React.JSX.Element {
    const disclosures = useNativeChatDisclosures()
    return (
      <NativeChatDisclosureContext.Provider value={disclosures}>
        {mounted ? (
          <NativeChatToolRun
            blocks={askBlocks('completed')}
            expandSignal
            activeTurnIsWorking={false}
            disclosureId="message-1"
          />
        ) : null}
      </NativeChatDisclosureContext.Provider>
    )
  }

  describe('NativeChatToolRun awaiting-input row', () => {
    afterEach(cleanup)

    it('preserves errors from failed question calls', () => {
      render(
        <NativeChatToolRun
          blocks={[
            { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'failed' },
            { type: 'tool-result', output: 'Question rejected', isError: true }
          ]}
          expandSignal
          activeTurnIsWorking={false}
        />
      )
      openToolRunMembers()
      expect(screen.queryByText('Awaiting user input:')).toBeNull()
      expect(screen.queryByText('Asked:')).toBeNull()
      expect(screen.getAllByText('Question rejected').length).toBeGreaterThan(0)
    })

    it('keeps an opened question open when the windowed row remounts', () => {
      const restore = clipEveryLine()
      try {
        const { rerender } = render(<DisclosureHarness mounted />)
        fireEvent.click(screen.getByRole('button', { name: /Asked:/ }))

        rerender(<DisclosureHarness mounted={false} />)
        expect(screen.queryByText(QUESTION)).toBeNull()
        rerender(<DisclosureHarness mounted />)

        const toggle = screen.getByRole('button', { name: /Asked:/ })
        expect(toggle).toHaveAttribute('aria-expanded', 'true')
        expect(screen.getByText(QUESTION).closest('button')).toBeNull()

        // Folding it keeps the same control, so keyboard focus is not dropped.
        toggle.focus()
        fireEvent.click(toggle)
        expect(document.activeElement).toBe(toggle)
        expect(toggle).toHaveAttribute('aria-expanded', 'false')
      } finally {
        restore()
      }
    })
  })
}

{
  const VIEWPORT = 200

  function calls(count: number): NativeChatBlock[] {
    return Array.from({ length: count }, (_, index) => ({
      type: 'tool-call' as const,
      name: 'Read',
      callId: `call-${index}`,
      input: `{"file_path":"src/file-${index}.ts"}`
    }))
  }

  /** happy-dom lays nothing out, so the box's geometry is whatever the test says it is. */
  function layOut(contentHeight: { current: number }): void {
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      () => contentHeight.current
    )
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
  }

  function membersBox(container: HTMLElement): HTMLElement {
    const box = container.querySelector<HTMLElement>('[data-native-chat-tool-run-members]')
    if (!box) {
      throw new Error('members box did not render')
    }
    return box
  }

  /** A run inside the transcript's disclosure store, which is what remembers its box. */
  function Transcript({
    mounted = true,
    count = 3,
    settled = false
  }: {
    mounted?: boolean
    count?: number
    settled?: boolean
  }): React.JSX.Element {
    const disclosures = useNativeChatDisclosures()
    return (
      <NativeChatDisclosureContext.Provider value={disclosures}>
        {settled ? (
          <button
            onClick={() => {
              for (let index = 0; index < MAX_NATIVE_CHAT_DISCLOSURES; index++) {
                disclosures.write(`line:pressure:${index}`, true)
              }
            }}
          >
            Expire other disclosures
          </button>
        ) : null}
        {mounted ? (
          <NativeChatToolRun
            blocks={calls(count)}
            expandSignal={!settled}
            activeTurnIsWorking={!settled}
            disclosureId="message-1"
          />
        ) : null}
      </NativeChatDisclosureContext.Provider>
    )
  }

  describe('NativeChatToolRun members box', () => {
    afterEach(() => {
      cleanup()
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })
    it('keeps a live run on its newest call until the reader scrolls away', () => {
      const contentHeight = { current: 600 }
      layOut(contentHeight)
      const run = (count: number): React.JSX.Element => (
        <NativeChatToolRun blocks={calls(count)} expandSignal activeTurnIsWorking />
      )
      const { container, rerender } = render(run(3))
      const box = membersBox(container)
      expect(box.scrollTop).toBe(600)

      contentHeight.current = 900
      rerender(run(4))
      expect(box.scrollTop).toBe(900)

      box.scrollTop = 100
      fireEvent.scroll(box)
      contentHeight.current = 1200
      rerender(run(5))
      expect(box.scrollTop).toBe(100)

      box.scrollTop = 1200 - VIEWPORT
      fireEvent.scroll(box)
      contentHeight.current = 1500
      rerender(run(6))
      expect(box.scrollTop).toBe(1500)
    })

    it('comes back where the reader left it after windowing unmounts the row', () => {
      const contentHeight = { current: 900 }
      layOut(contentHeight)
      const { container, rerender } = render(<Transcript mounted count={3} />)
      const box = membersBox(container)
      box.scrollTop = 100
      fireEvent.scroll(box)

      rerender(<Transcript mounted={false} count={3} />)
      contentHeight.current = 1200
      rerender(<Transcript mounted count={4} />)

      expect(membersBox(container).scrollTop).toBe(100)
    })

    it('forgets its place when the reader closes it', () => {
      layOut({ current: 900 })
      const { container } = render(<Transcript />)
      const box = membersBox(container)
      box.scrollTop = 100
      fireEvent.scroll(box)

      const header = container.querySelector<HTMLElement>('[data-native-chat-tool-run-state]')!
      fireEvent.click(header)
      fireEvent.click(header)

      expect(membersBox(container).scrollTop).toBe(900)
    })

    it('opens fresh after a mounted expired run records more scroll and is recycled', () => {
      let resizeMembers: (() => void) | undefined
      vi.stubGlobal(
        'ResizeObserver',
        class implements ResizeObserver {
          constructor(private readonly callback: ResizeObserverCallback) {}
          observe(target: Element): void {
            if (target.hasAttribute('data-native-chat-tool-run-members')) {
              resizeMembers = () => this.callback([], this)
            }
          }
          unobserve(): void {}
          disconnect(): void {}
        }
      )
      layOut({ current: 900 })
      const { container, rerender } = render(<Transcript settled />)
      const header = container.querySelector<HTMLElement>('[data-native-chat-tool-run-state]')!
      fireEvent.click(header)
      const box = membersBox(container)
      box.scrollTop = 120
      fireEvent.scroll(box)

      fireEvent.click(screen.getByRole('button', { name: 'Expire other disclosures' }))
      box.scrollTop = 140
      if (!resizeMembers) {
        throw new Error('members resize observer did not attach')
      }
      act(resizeMembers)
      box.scrollTop = 160
      fireEvent.scroll(box)
      expect(header).toHaveAttribute('aria-expanded', 'true')
      expect(membersBox(container)).toBe(box)
      expect(box.scrollTop).toBe(160)

      rerender(<Transcript settled mounted={false} />)
      rerender(<Transcript settled />)
      const returnedHeader = container.querySelector<HTMLElement>(
        '[data-native-chat-tool-run-state]'
      )!
      expect(returnedHeader).toHaveAttribute('aria-expanded', 'false')
      expect(container.querySelector('[data-native-chat-tool-run-members]')).toBeNull()
      fireEvent.click(returnedHeader)
      expect(membersBox(container).scrollTop).toBe(0)
    })
  })
}
