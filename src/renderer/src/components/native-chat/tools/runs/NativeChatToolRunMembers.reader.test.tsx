// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useMemo } from 'react'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatDiffReveal } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { NativeChatToolRun } from './NativeChatToolRun'
import { NativeChatToolRunWindowContext } from './native-chat-tool-run-window-context'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../../messages/disclosure/native-chat-disclosure-store'

const BOX_HEIGHT_PX = 288
/** Measured rows are taller than the 26px estimate, so a pixel position alone lands on the wrong row. */
const ROW_HEIGHT_PX = 40
const ROW = '[data-native-chat-tool-run-row]'
/** Rows that have grown in place, by row key. */
const grownRows = new Map<string, number>()
/** A hidden pane is display:none: nothing in it has a size. */
const pane = { hidden: false }

const resizeObservers = new Set<StubResizeObserver>()
class StubResizeObserver implements ResizeObserver {
  readonly targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    resizeObservers.add(this)
  }
  observe(target: Element): void {
    this.targets.add(target)
  }
  unobserve(target: Element): void {
    this.targets.delete(target)
  }
  disconnect(): void {
    this.targets.clear()
    resizeObservers.delete(this)
  }
}

/** Deliver what a browser's ResizeObserver would after `element` changed size. */
function resized(element: Element, height: number): void {
  for (const observer of resizeObservers) {
    if (observer.targets.has(element)) {
      const size = { blockSize: height, inlineSize: 400 }
      const entry = {
        target: element,
        contentRect: element.getBoundingClientRect(),
        borderBoxSize: [size],
        contentBoxSize: [size],
        devicePixelContentBoxSize: [size]
      } satisfies ResizeObserverEntry
      observer.callback([entry], observer)
    }
  }
}

function rowHeight(element: Element): number {
  return grownRows.get(element.getAttribute('data-native-chat-tool-run-row') ?? '') ?? ROW_HEIGHT_PX
}

/** happy-dom lays nothing out: stack the run box's children by their stated heights. */
function layOutRunBox(): void {
  const heightOf = (element: Element): number => {
    if (pane.hidden) {
      return 0
    }
    if (element.matches(ROW)) {
      return rowHeight(element)
    }
    return element instanceof HTMLElement ? Number.parseFloat(element.style.height) || 0 : 0
  }
  const box = (element: Element): HTMLElement | null =>
    element.closest<HTMLElement>('[data-native-chat-tool-run-members]')
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    if (pane.hidden) {
      return 0
    }
    if (this.hasAttribute('data-native-chat-tool-run-members')) {
      return BOX_HEIGHT_PX
    }
    return this.matches(ROW) ? rowHeight(this) : 0
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.hasAttribute('data-native-chat-tool-run-members') ? BOX_HEIGHT_PX : 0
  })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    const content = this.hasAttribute('data-native-chat-tool-run-members')
      ? this.firstElementChild
      : null
    return content ? Array.from(content.children).reduce((sum, c) => sum + heightOf(c), 0) : 0
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const scroller = box(this)
    if (!scroller || pane.hidden) {
      return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
    }
    if (this === scroller) {
      return DOMRect.fromRect({ x: 0, y: 0, width: 400, height: BOX_HEIGHT_PX })
    }
    const row = this.closest(ROW) ?? this
    let top = -scroller.scrollTop
    for (const child of Array.from(scroller.firstElementChild?.children ?? [])) {
      if (child === row) {
        return DOMRect.fromRect({ x: 0, y: top, width: 400, height: heightOf(child) })
      }
      top += heightOf(child)
    }
    return DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 })
  })
}

function calls(count: number): NativeChatBlock[] {
  return Array.from({ length: count }, (_, index) => ({
    type: 'tool-call' as const,
    name: 'Read',
    callId: `call-${index}`,
    input: { file_path: `src/file-${index}.ts` }
  }))
}

const PATCH =
  '*** Begin Patch\n*** Update File: first.ts\n ctx\n-was\n+now\n*** Update File: second.ts\n@@ -1,1 +1,1 @@\n-a\n+b\n*** End Patch'

/** A long settled run with one two-file edit far from its top. */
function editRun(count: number, editAt: number): NativeChatBlock[] {
  const blocks = calls(count)
  blocks.splice(
    editAt,
    0,
    {
      type: 'tool-call',
      name: 'apply_patch',
      callId: 'edit-1',
      input: { input: PATCH },
      state: 'completed'
    },
    { type: 'tool-result', callId: 'edit-1', output: 'Success. Updated the following files' }
  )
  return blocks
}

function Transcript({
  blocks,
  mounted = true,
  live = false,
  visible = true,
  revealedDiff
}: {
  blocks: NativeChatBlock[]
  mounted?: boolean
  live?: boolean
  visible?: boolean
  revealedDiff?: NativeChatDiffReveal
}) {
  const disclosures = useNativeChatDisclosures()
  const windowFacts = useMemo(() => ({ isVisible: visible, findActive: false }), [visible])
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      <NativeChatToolRunWindowContext.Provider value={windowFacts}>
        {mounted ? (
          <NativeChatToolRun
            blocks={blocks}
            expandSignal
            activeTurnIsWorking={live}
            disclosureId="message-1"
            revealedDiff={revealedDiff}
            onRevealDiff={() => {}}
          />
        ) : null}
      </NativeChatToolRunWindowContext.Provider>
    </NativeChatDisclosureContext.Provider>
  )
}

function membersBox(container: HTMLElement): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-native-chat-tool-run-members]')
  if (!element) {
    throw new Error('members box did not render')
  }
  return element
}

/** The row at the box's top edge and how far into it the box starts. */
function topRow(container: HTMLElement): { key: string | null; offset: number } {
  for (const row of Array.from(container.querySelectorAll(ROW))) {
    const rect = row.getBoundingClientRect()
    if (rect.bottom > 0) {
      return { key: row.getAttribute('data-native-chat-tool-run-row'), offset: -rect.top }
    }
  }
  return { key: null, offset: 0 }
}

/** Deliver frames and the anchor's idle record on the fake clock: no wall-clock waits. */
async function settle(): Promise<void> {
  for (let pass = 0; pass < 4; pass++) {
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
  }
}

async function scrollBox(container: HTMLElement, top: number): Promise<void> {
  const box = membersBox(container)
  await act(async () => {
    box.scrollTop = top
    fireEvent.scroll(box)
  })
  await settle()
}

describe('NativeChatToolRun opened-run reader', () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame']
    })
    grownRows.clear()
    pane.hidden = false
    vi.stubGlobal('ResizeObserver', StubResizeObserver)
    layOutRunBox()
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('returns to the same row and offset after the transcript unmounts it and work arrives', async () => {
    const { container, rerender } = render(<Transcript blocks={calls(1_000)} />)
    await settle()
    await scrollBox(container, 9_013)
    const before = topRow(container)
    expect(before.key).not.toBeNull()
    expect(before.offset).toBeGreaterThan(0)

    rerender(<Transcript blocks={calls(1_000)} mounted={false} />)
    rerender(<Transcript blocks={calls(1_010)} />)
    await settle()

    const after = topRow(container)
    expect(after.key).toBe(before.key)
    expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1)
  })

  it('keeps a revealed edit at the top over the place the reader had scrolled to', async () => {
    const blocks = editRun(600, 400)
    const { container, rerender } = render(<Transcript blocks={blocks} />)
    await settle()
    await scrollBox(container, 2_000)
    const reveal = { messageId: 'message-1', editKey: 'apply_patch:400', fileIndex: 1 }

    rerender(<Transcript blocks={blocks} revealedDiff={{ ...reveal, requestId: 1 }} />)
    await settle()
    expect(topRow(container).key).toBe('edit:apply_patch:400')

    await scrollBox(container, 2_000)
    rerender(<Transcript blocks={blocks} revealedDiff={{ ...reveal, requestId: 2 }} />)
    await settle()
    expect(topRow(container).key).toBe('edit:apply_patch:400')
  })

  it('forgets its place when the reader closes and reopens it', async () => {
    const { container } = render(<Transcript blocks={calls(1_000)} />)
    await settle()
    await scrollBox(container, 9_013)
    const header = container.querySelector<HTMLElement>('[data-native-chat-tool-run-state]')
    if (!header) {
      throw new Error('run header did not render')
    }
    await act(async () => {
      fireEvent.click(header)
    })
    await settle()
    await act(async () => {
      fireEvent.click(header)
    })
    await settle()
    expect(membersBox(container).scrollTop).toBe(0)
    expect(topRow(container).key).toBe('call:call-0')
  })

  it('follows new work at the end, but not a detail growing after it lands', async () => {
    const { container, rerender } = render(<Transcript blocks={calls(200)} live />)
    await settle()
    const box = membersBox(container)
    const atEnd = (): boolean => box.scrollTop >= box.scrollHeight - BOX_HEIGHT_PX - 1
    expect(atEnd()).toBe(true)

    // A burst larger than the window, then a result that adds no row.
    rerender(<Transcript blocks={calls(260)} live />)
    await settle()
    expect(atEnd()).toBe(true)
    const withResult = [
      ...calls(260),
      { type: 'tool-result' as const, callId: 'call-259', output: 'done' }
    ]
    rerender(<Transcript blocks={withResult} live />)
    await settle()
    expect(atEnd()).toBe(true)

    // In-place growth that is not new work leaves the reader where they are.
    const landed = box.scrollTop
    const tail = container.querySelector('[data-native-chat-tool-run-row="call:call-259"]')
    if (!tail) {
      throw new Error('tail row is not drawn')
    }
    grownRows.set('call:call-259', 400)
    await act(async () => {
      resized(tail, 400)
    })
    await settle()
    expect(box.scrollTop).toBe(landed)

    // A reader scrolled away stays put when more work arrives.
    await scrollBox(container, 1_000)
    rerender(<Transcript blocks={[...withResult, ...calls(270).slice(260)]} live />)
    await settle()
    expect(box.scrollTop).toBe(1_000)
  })

  it('lets a reveal win over a restore that has not landed yet', async () => {
    const blocks = editRun(600, 400)
    const { container, rerender } = render(<Transcript blocks={blocks} />)
    await settle()
    await scrollBox(container, 2_000)
    rerender(<Transcript blocks={blocks} mounted={false} />)
    rerender(<Transcript blocks={blocks} />)
    // No settling: the returning restore is still pending when the reveal arrives.
    const reveal = { messageId: 'message-1', editKey: 'apply_patch:400', fileIndex: 1 }
    rerender(<Transcript blocks={blocks} revealedDiff={{ ...reveal, requestId: 1 }} />)
    await settle()
    expect(topRow(container).key).toBe('edit:apply_patch:400')
  })

  it('stops following when the reader scrolls before new work has settled', async () => {
    const { container, rerender } = render(<Transcript blocks={calls(200)} live />)
    await settle()
    const box = membersBox(container)
    rerender(<Transcript blocks={calls(260)} live />)
    await act(async () => {
      box.scrollTop = 1_000
      fireEvent.scroll(box)
    })
    await settle()
    expect(box.scrollTop).toBe(1_000)
  })

  it('finishes a follow that started while the pane was hidden once it shows again', async () => {
    const { container, rerender } = render(<Transcript blocks={calls(200)} live />)
    await settle()
    pane.hidden = true
    rerender(<Transcript blocks={calls(200)} live visible={false} />)
    rerender(<Transcript blocks={calls(230)} live visible={false} />)
    await settle()
    pane.hidden = false
    rerender(<Transcript blocks={calls(230)} live />)
    await settle()
    const box = membersBox(container)
    expect(box.scrollTop).toBeGreaterThanOrEqual(box.scrollHeight - BOX_HEIGHT_PX - 1)
  })

  it('does not keep a selection span drawn after it ended while the pane was hidden', async () => {
    const { container, rerender } = render(<Transcript blocks={calls(1_000)} />)
    await settle()
    const box = membersBox(container)
    await act(async () => {
      document.getSelection()?.selectAllChildren(box)
      document.dispatchEvent(new Event('selectionchange'))
    })
    expect(container.querySelectorAll(ROW).length).toBe(1_000)

    pane.hidden = true
    rerender(<Transcript blocks={calls(1_000)} visible={false} />)
    await act(async () => {
      document.getSelection()?.removeAllRanges()
      document.dispatchEvent(new Event('selectionchange'))
    })
    pane.hidden = false
    rerender(<Transcript blocks={calls(1_000)} />)
    await settle()
    expect(container.querySelectorAll(ROW).length).toBeLessThan(100)
  })
})
