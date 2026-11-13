// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'

import { NativeChatToolRun } from './NativeChatToolRun'

import {
  MAX_NATIVE_CHAT_DISCLOSURES,
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../../messages/disclosure/native-chat-disclosure-store'

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
