// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { createProgrammaticScrollMarks } from '@/hooks/programmatic-scroll-marks'
import type { NativeChatToolRunRow } from './native-chat-tool-run-rows'
import { ROW_KEY_ATTRIBUTE } from './use-native-chat-tool-run-pins'
import {
  claimNativeChatToolRunReveal,
  useNativeChatToolRunReaderPosition
} from './use-native-chat-tool-run-reader-position'
import type { NativeChatToolRunVirtualizer } from './use-native-chat-tool-run-window'

// The window's size model, deliberately stale: the edit row is still its cached 78 px while the page has it far
// taller. Rows after it follow the cached height.
const MODEL_ROWS = [
  'call:before',
  'edit:patch',
  'call:after-1',
  'call:after-2',
  'call:after-3',
  'call:after-4',
  'call:after-5',
  'call:after-6',
  'call:after-7',
  'call:after-8',
  'call:after-9',
  'call:after-10'
]
const MODEL_STARTS = [
  0, 1_000, 1_078, 1_118, 1_158, 1_198, 1_238, 1_278, 1_318, 1_358, 1_398, 1_438
]

const rows = MODEL_ROWS.map(
  (key) => ({ kind: 'line', key, focusable: true }) as unknown as NativeChatToolRunRow
)
const rowIndexByKey = new Map(MODEL_ROWS.map((key, index) => [key, index]))
const measurementsCache = MODEL_STARTS.map((start, index) => {
  const size = (MODEL_STARTS[index + 1] ?? start + 40) - start
  return { index, start, size, end: start + size, key: MODEL_ROWS[index]!, lane: 0 }
})
const staleModel = {
  measurementsCache,
  scrollOffset: 0,
  getVirtualItemForOffset: (offset: number) =>
    measurementsCache.findLast((item) => item.start <= offset)
} as unknown as NativeChatToolRunVirtualizer

function setClientHeight(element: Element, height: number): void {
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height })
}

function setRect(element: Element, top: number, height: number): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => DOMRect.fromRect({ x: 0, y: top, width: 300, height })
  })
}

/** A run box whose drawn children sit at literal page positions relative to a 288 px box at the page top. */
function runBox(
  children: { key?: string; top: number; height: number }[],
  boxHeight = 288
): {
  scroller: HTMLDivElement
  rowsByKey: Map<string, HTMLDivElement>
} {
  const scroller = document.createElement('div')
  const content = document.createElement('div')
  scroller.append(content)
  document.body.append(scroller)
  setRect(scroller, 0, boxHeight)
  setClientHeight(scroller, boxHeight)
  const rowsByKey = new Map<string, HTMLDivElement>()
  for (const child of children) {
    const element = document.createElement('div')
    if (child.key) {
      element.setAttribute(ROW_KEY_ATTRIBUTE, child.key)
      rowsByKey.set(child.key, element)
    }
    setRect(element, child.top, child.height)
    content.append(element)
  }
  return { scroller, rowsByKey }
}

function moveChildren(
  rowsByKey: Map<string, HTMLDivElement>,
  positions: Record<string, [number, number]>
): void {
  for (const [key, [top, height]] of Object.entries(positions)) {
    setRect(rowsByKey.get(key)!, top, height)
  }
}

function owner(scroller: HTMLDivElement) {
  return renderHook(
    ({ isVisible }: { isVisible: boolean }) =>
      useNativeChatToolRunReaderPosition({
        scrollerRef: { current: scroller },
        virtualizer: staleModel,
        rows,
        rowIndexByKey,
        isVisible,
        followsEndRef: { current: false },
        marks: createProgrammaticScrollMarks(),
        totalSize: 1_478,
        initial: undefined,
        setHeldRowKey: vi.fn(),
        onRevealed: vi.fn()
      }),
    { initialProps: { isVisible: true } }
  )
}

/** A card inside a drawn row scrolls itself to the box top and claims the place. */
function revealCardIn(scroller: HTMLDivElement, row: HTMLDivElement): void {
  const card = document.createElement('div')
  row.append(card)
  claimNativeChatToolRunReveal(scroller, card)
}

describe('tool-run reader position with a stale size model', () => {
  afterEach(() => {
    cleanup()
    document.body.replaceChildren()
  })

  it("keeps a revealed file's place through its own scroll report and a hide", () => {
    // Box at 1,400: the edit really starts at 1,000 and is 600 tall; the next row starts at 1,600.
    const { scroller, rowsByKey } = runBox([
      { top: -1_400, height: 1_000 },
      { key: 'edit:patch', top: -400, height: 600 },
      { key: 'call:after-1', top: 200, height: 40 }
    ])
    const { result, rerender } = owner(scroller)
    revealCardIn(scroller, rowsByKey.get('edit:patch')!)
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 400 })

    // The reveal's own native scroll report, before the edit's new height reaches the model.
    result.current.onScrolled(1_400, true)
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 400 })

    rerender({ isVisible: false })
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 400 })
  })

  it('follows the reader inside the tall row and across its edge before the model catches up', () => {
    const { scroller, rowsByKey } = runBox([
      { top: -1_400, height: 1_000 },
      { key: 'edit:patch', top: -400, height: 600 },
      { key: 'call:after-1', top: 200, height: 40 }
    ])
    const { result } = owner(scroller)
    revealCardIn(scroller, rowsByKey.get('edit:patch')!)

    moveChildren(rowsByKey, { 'edit:patch': [-420, 600], 'call:after-1': [180, 40] })
    result.current.onScrolled(1_420, true)
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 420 })

    moveChildren(rowsByKey, { 'edit:patch': [-610, 600], 'call:after-1': [-10, 40] })
    result.current.onScrolled(1_610, true)
    expect(result.current.current()).toEqual({ key: 'call:after-1', offset: 10 })
  })

  it('takes the next drawn row across a blank row and a card margin', () => {
    // Edit bottom at 1,600, a blank thought at 1,600, the next call at 1,604 (the card's margin); box at 1,602.
    const { scroller } = runBox([
      { top: -1_602, height: 1_000 },
      { key: 'edit:patch', top: -602, height: 600 },
      { key: 'call:before', top: -2, height: 0 },
      { key: 'call:after-1', top: 2, height: 40 }
    ])
    const { result } = owner(scroller)
    result.current.onScrolled(1_602, true)
    expect(result.current.current()).toEqual({ key: 'call:after-1', offset: 0 })
  })

  it('keeps the place when the box has no geometry, even where the model has an answer', () => {
    const { scroller, rowsByKey } = runBox([
      { top: -1_400, height: 1_000 },
      { key: 'edit:patch', top: -400, height: 600 }
    ])
    const { result } = owner(scroller)
    revealCardIn(scroller, rowsByKey.get('edit:patch')!)
    setRect(scroller, 0, 0)
    setClientHeight(scroller, 0)
    result.current.onScrolled(0, true)
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 400 })
  })

  it('records the actual place after a clamped report and a compensation write', () => {
    const { scroller, rowsByKey } = runBox([
      { top: -1_900, height: 1_000 },
      { key: 'edit:patch', top: -900, height: 1_200 }
    ])
    const { result } = owner(scroller)
    revealCardIn(scroller, rowsByKey.get('edit:patch')!)
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 900 })

    // The box could only reach 1,880.
    moveChildren(rowsByKey, { 'edit:patch': [-880, 1_200] })
    result.current.onScrolled(1_880, true)
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 880 })

    // The window's own compensation write (not the reader) moved it to 1,912.
    moveChildren(rowsByKey, { 'edit:patch': [-912, 1_200] })
    result.current.onScrolled(1_912, false)
    expect(result.current.current()).toEqual({ key: 'edit:patch', offset: 912 })
    expect(scroller.scrollTop).toBe(0)
  })

  it('uses the model only where the box top lies in an undrawn gap', () => {
    // A wrapper for a row no longer in the run, then a spacer: the top is undrawn, so the model answers.
    const { scroller } = runBox([
      { key: 'call:gone', top: -10, height: 40 },
      { top: 30, height: 5_000 }
    ])
    const { result } = owner(scroller)
    result.current.onScrolled(1_130, true)
    expect(result.current.current()).toEqual({ key: 'call:after-2', offset: 12 })
  })
})
