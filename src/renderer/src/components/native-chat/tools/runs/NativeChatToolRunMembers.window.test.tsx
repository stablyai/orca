// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useMemo } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatToolRunWindowContext } from './native-chat-tool-run-window-context'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../../messages/disclosure/native-chat-disclosure-store'

const BOX_HEIGHT_PX = 288
const ROW_HEIGHT_PX = 26
/** 12 rows fill the box, 10 overscan rows on each side, and the first/last rows stay drawn. */
const MAX_DRAWN_ROWS = 12 + 2 * 10 + 2

function calls(count: number): NativeChatBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'tool-call' as const,
    name: 'Read',
    callId: `call-${index}`,
    input: { file_path: `src/file-${index}.ts` }
  }))
}

/** Two task-list updates (the second shows its "Full task list" control), then Read calls up to `count` rows. */
function withTaskList(count: number): NativeChatBlock[] {
  const todo = (status: string): NativeChatBlock => ({
    type: 'tool-call',
    name: 'TodoWrite',
    input: { todos: [{ content: 'Audit the window', status }] }
  })
  return [todo('pending'), todo('in_progress'), ...calls(count - 2)]
}

function Run({
  count,
  findActive = false,
  blocks = calls(count)
}: {
  count: number
  findActive?: boolean
  blocks?: NativeChatBlock[]
}) {
  const disclosures = useNativeChatDisclosures()
  const windowFacts = useMemo(() => ({ isVisible: true, findActive }), [findActive])
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatToolRunWindowContext.Provider value={windowFacts}>
        <NativeChatToolRun
          blocks={blocks}
          expandSignal
          activeTurnIsWorking={false}
          disclosureId="message-1"
        />
      </NativeChatToolRunWindowContext.Provider>
    </NativeChatDisclosureContext.Provider>
  )
}

function drawnRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[data-native-chat-tool-run-row]'))
}

function rowButton(container: HTMLElement, index: number): HTMLElement {
  const button = container.querySelector<HTMLElement>(
    `[data-native-chat-tool-run-row="call:call-${index}"] button`
  )
  if (!button) {
    throw new Error(`row ${index} is not drawn`)
  }
  return button
}

describe('NativeChatToolRun opened-run window', () => {
  beforeEach(() => {
    // happy-dom lays nothing out: the box and each row get the sizes the test states.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      if (this.hasAttribute('data-native-chat-tool-run-members')) {
        return BOX_HEIGHT_PX
      }
      return this.hasAttribute('data-native-chat-tool-run-row') ? ROW_HEIGHT_PX : 0
    })
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('draws the same bounded window of a long run at 2,000 and 20,000 calls', () => {
    for (const count of [2_000, 20_000]) {
      const { container, unmount } = render(<Run count={count} />)
      const drawn = drawnRows(container)
      expect(drawn.length).toBeGreaterThan(0)
      expect(drawn.length).toBeLessThanOrEqual(MAX_DRAWN_ROWS)
      // A settled run reads from its top, and its last row stays drawn for the tail.
      expect(rowButton(container, 0)).toBeInTheDocument()
      expect(rowButton(container, count - 1)).toBeInTheDocument()
      unmount()
    }
  })

  it('draws every row while Find has a query, then returns to the window without remounting', () => {
    const { container, rerender } = render(<Run count={200} />)
    const first = rowButton(container, 0)
    expect(drawnRows(container).length).toBeLessThanOrEqual(MAX_DRAWN_ROWS)

    rerender(<Run count={200} findActive />)
    expect(drawnRows(container)).toHaveLength(200)
    expect(rowButton(container, 0)).toBe(first)

    rerender(<Run count={200} />)
    expect(drawnRows(container).length).toBeLessThanOrEqual(MAX_DRAWN_ROWS)
    expect(rowButton(container, 0)).toBe(first)
  })

  it('keeps a focused row and an opened full task list through windowing and Find', () => {
    const { container, rerender } = render(<Run count={49} blocks={withTaskList(49)} />)
    fireEvent.click(screen.getByRole('button', { name: /Full task list/ }))
    const fullList = screen.getByRole('button', { name: /Full task list/ })
    expect(fullList).toHaveAttribute('aria-expanded', 'true')
    const focused = rowButton(container, 10)
    focused.focus()

    rerender(<Run count={50} blocks={withTaskList(50)} />)
    expect(focused).toBeInTheDocument()
    expect(document.activeElement).toBe(focused)
    expect(screen.getByRole('button', { name: /Full task list/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    rerender(<Run count={50} blocks={withTaskList(50)} findActive />)
    rerender(<Run count={50} blocks={withTaskList(50)} />)
    expect(screen.getByRole('button', { name: /Full task list/ })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
  })
})
