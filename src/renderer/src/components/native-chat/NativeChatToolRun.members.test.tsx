// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../../shared/native-chat-types'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from './native-chat-disclosure-store'
import { NativeChatToolRun } from './NativeChatToolRun'
import { revealNativeChatToolRunMember } from './NativeChatToolRunMembers'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

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

/** A live run inside the transcript's disclosure store, which is what remembers its box. */
function Transcript({
  mounted = true,
  count = 3
}: {
  mounted?: boolean
  count?: number
}): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      {mounted ? (
        <NativeChatToolRun
          blocks={calls(count)}
          expandSignal
          activeTurnIsWorking
          disclosureId="message-1"
        />
      ) : null}
    </NativeChatDisclosureContext.Provider>
  )
}

describe('NativeChatToolRun members box', () => {
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

    // Neither back at the newest call nor following again: both were the reader's choice.
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

    // A live run the reader reopens shows what it is doing now.
    expect(membersBox(container).scrollTop).toBe(900)
  })

  it('opens a settled run at its first call', () => {
    layOut({ current: 600 })
    const { container } = render(
      <NativeChatToolRun blocks={calls(3)} expandSignal activeTurnIsWorking={false} />
    )
    expect(membersBox(container).scrollTop).toBe(0)
  })

  it('brings a revealed member to the top of the box and reports the box', () => {
    layOut({ current: 600 })
    const { container } = render(
      <NativeChatToolRun blocks={calls(3)} expandSignal activeTurnIsWorking={false} />
    )
    const box = membersBox(container)
    const member = box.querySelectorAll('button')[2]!
    vi.spyOn(box, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 300, VIEWPORT))
    vi.spyOn(member, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 340, 300, 26))

    expect(revealNativeChatToolRunMember(member)).toBe(box)
    expect(box.scrollTop).toBe(300)
  })
})

describe('NativeChatToolRun asides', () => {
  it('draws the rows it is handed among its calls, in order', () => {
    const blocks = calls(2)
    const { container } = render(
      <NativeChatToolRun
        blocks={blocks}
        asides={{
          before: new Map([[blocks[1]!, [<p key="between">between</p>]]]),
          after: [<p key="last">last</p>]
        }}
        expandSignal
        activeTurnIsWorking={false}
      />
    )
    const rows = [...membersBox(container).querySelectorAll('button, p')].map(
      (row) => row.textContent ?? ''
    )
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('file-0.ts')
    expect(rows[1]).toBe('between')
    expect(rows[2]).toContain('file-1.ts')
    expect(rows[3]).toBe('last')
  })
})
