// @vitest-environment happy-dom

import { act, useMemo, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import userEvent from '@testing-library/user-event'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getOverlayFocusOwners } from '@/lib/overlay-interaction/overlay-focus-ownership'
import { NativeChatContextClearFade } from '../../conversation/projection/NativeChatContextClearFade'
import type { NativeChatTranscriptSlot } from '../../conversation/slots/native-chat-transcript-slots'
import type {
  NativeChatRailItem,
  NativeChatRailOutlineEntry
} from './native-chat-message-rail-items'
import { NativeChatMessageRail } from './NativeChatMessageRail'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'

// Rail and hook together in a tall pane, as NativeChatMessageList renders them: the tick cap, the
// list's inventory and its focus contract with the composer.

type Props = {
  loaded: number
  outline?: number
  listEnabled?: boolean
  clearing?: boolean
  onSelect: (item: NativeChatRailItem) => void
}

function slotsOf(loaded: number, from: number): NativeChatTranscriptSlot[] {
  return Array.from(
    { length: loaded },
    (_, index) =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the rail reads only these slot and message fields.
      ({
        kind: 'message',
        turnKey: `m${from + index}`,
        message: {
          id: `m${from + index}`,
          role: 'user',
          source: 'transcript',
          timestamp: Date.UTC(2026, 10, 20, 9, index),
          blocks: [{ type: 'text', text: `prompt ${from + index + 1}` }]
        }
      }) as unknown as NativeChatTranscriptSlot
  )
}

function Rail({ loaded, outline = 0, listEnabled = true, onSelect }: Props): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const slots = useMemo(() => slotsOf(loaded, outline), [loaded, outline])
  const entries = useMemo<NativeChatRailOutlineEntry[]>(
    () =>
      Array.from({ length: outline }, (_, index) => ({
        id: `m${index}`,
        text: `older ${index + 1}`,
        hasImages: false
      })),
    [outline]
  )
  const turnRows = useMemo(() => ({ messages: [], turnKeys: [] }), [])
  const rail = useNativeChatMessageRail({
    scrollRef,
    slots,
    turnRows,
    virtualItems: [],
    outline: entries
  })
  return (
    <div className="relative">
      <div ref={scrollRef} data-native-chat-scroll />
      <NativeChatMessageRail
        rail={rail}
        railRef={railRef}
        scrollRef={scrollRef}
        onSelect={onSelect}
        listEnabled={listEnabled}
      />
      <button type="button">Jump to latest</button>
    </div>
  )
}

function Harness(props: Props): React.JSX.Element {
  return (
    <>
      <textarea aria-label="composer" defaultValue="hello world" />
      <NativeChatContextClearFade clearing={props.clearing ?? false}>
        <Rail {...props} />
      </NativeChatContextClearFade>
    </>
  )
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const onSelect = vi.fn<(item: NativeChatRailItem) => void>()

beforeEach(() => {
  vi.useFakeTimers()
  // Testing Library drains its own setTimeout(0) after user-event only under jest-named fake timers.
  vi.stubGlobal('jest', { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) })
  // A 800×900 pane; every box lays out at 300×400 so the list has a window to render.
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(300)
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 400))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  onSelect.mockReset()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function render(props: Omit<Props, 'onSelect'>): void {
  act(() => root.render(<Harness {...props} onSelect={onSelect} />))
}

const ticks = (): HTMLButtonElement[] =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('[data-native-chat-rail-tick]'))
const panel = (): HTMLElement | null => container.querySelector('[data-native-chat-rail-panel]')
const filter = (): HTMLInputElement | null =>
  container.querySelector('[data-native-chat-rail-panel] input')
const composer = (): HTMLTextAreaElement => container.querySelector('textarea')!
const tabStop = (): HTMLButtonElement => ticks().find((tick) => tick.tabIndex === 0)!

function hoverRail(): void {
  const rail = container.querySelector('[data-native-chat-rail]')!
  act(() => {
    fireEvent.pointerOver(rail, { pointerType: 'mouse' })
  })
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function user() {
  return userEvent.setup({ delay: null })
}

describe('NativeChatMessageRail in a tall pane', () => {
  it('keeps 20 loaded messages in short mode: 20 ticks and no list on hover', () => {
    render({ loaded: 20 })
    expect(ticks()).toHaveLength(20)
    hoverRail()
    wait(400)
    expect(panel()).toBeNull()
    expect(tabStop().getAttribute('aria-keyshortcuts')).toBeNull()
  })

  it('lists 21 loaded messages 200ms after hover, still drawing 20 ticks', () => {
    render({ loaded: 21 })
    expect(ticks()).toHaveLength(20)
    hoverRail()
    wait(199)
    expect(panel()).toBeNull()
    wait(1)
    expect(panel()).not.toBeNull()
    expect(tabStop().getAttribute('aria-keyshortcuts')).toBe('Alt+ArrowDown')
  })

  it('samples 180 loaded messages to exactly 20 ticks, keeping both ends', () => {
    render({ loaded: 180 })
    const labels = ticks().map((tick) => tick.getAttribute('aria-label'))
    expect(labels).toHaveLength(20)
    expect(labels[0]).toBe('Message 1 of 180: prompt 1')
    expect(labels.at(-1)).toBe('Message 180 of 180: prompt 180')
  })

  it('caps 20 loaded and 160 outline messages at 20 ticks with no list', () => {
    render({ loaded: 20, outline: 160 })
    expect(ticks()).toHaveLength(20)
    hoverRail()
    wait(400)
    expect(panel()).toBeNull()
    // An outline tick keeps today's jump, which pages history in.
    act(() => ticks()[0]!.click())
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'm0', slotIndex: null }))
  })

  it('closes the list and its timers when loaded history trims back to 20', () => {
    render({ loaded: 21 })
    hoverRail()
    wait(200)
    expect(panel()).not.toBeNull()
    render({ loaded: 20 })
    expect(panel()).toBeNull()
    hoverRail()
    wait(1000)
    expect(panel()).toBeNull()
  })
})

describe('rail keys', () => {
  it('walks into unsampled outline ticks; Space jumps one; Alt+↓ lists only loaded', async () => {
    const keys = user()
    render({ loaded: 30, outline: 150 })
    act(() => tabStop().focus())
    await keys.keyboard('{Home}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Message 4 of 180: older 4')
    await keys.keyboard(' ')
    expect(onSelect).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'm3', slotIndex: null })
    )
    await keys.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(document.activeElement).toBe(filter())
    expect(panel()?.getAttribute('role')).toBe('dialog')
    // Only the 30 loaded prompts are listed; the 150 outline ones are not.
    await keys.keyboard('p')
    expect(panel()?.textContent).toContain('30 of 30')
    // Esc clears the query, then returns to the outline tick that opened the list.
    await keys.keyboard('{Escape}{Escape}')
    expect(panel()).toBeNull()
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Message 4 of 180: older 4')
  })

  it('Esc clears a query before closing; Tab and Shift+Tab leave and close', async () => {
    const keys = user()
    render({ loaded: 30 })
    const opener = tabStop()
    act(() => opener.focus())
    await keys.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await keys.keyboard('prompt 1')
    await keys.keyboard('{Escape}')
    expect(filter()?.value).toBe('')
    expect(panel()).not.toBeNull()
    await keys.keyboard('{Shift>}{Tab}{/Shift}')
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(opener)
    await keys.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await keys.keyboard('{Tab}')
    expect(panel()).toBeNull()
    expect(document.activeElement?.textContent).toBe('Jump to latest')
  })

  it('shows no count until the reader types, then "n of N" over the listed rows', async () => {
    const keys = user()
    render({ loaded: 180 })
    act(() => tabStop().focus())
    await keys.keyboard('{Alt>}{ArrowDown}{/Alt}')
    expect(panel()?.textContent).not.toMatch(/\d+ of \d+/)
    await keys.keyboard('prompt 1')
    // prompt 1, 10–19, 100–180
    expect(panel()?.textContent).toContain('92 of 180')
  })

  it('Enter picks the highlighted loaded row and returns focus to the opener', async () => {
    const keys = user()
    render({ loaded: 30 })
    const opener = tabStop()
    act(() => opener.focus())
    await keys.keyboard('{Alt>}{ArrowDown}{/Alt}')
    await keys.keyboard('prompt 12{Enter}')
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm11', slotIndex: 11 }))
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})

describe('hover mode beside a focused composer', () => {
  it('never owns focus or Escape, and a pointer pick keeps the caret', async () => {
    const keys = user()
    render({ loaded: 30 })
    act(() => {
      composer().focus()
      composer().setSelectionRange(5, 5)
    })
    hoverRail()
    wait(200)
    expect(panel()).not.toBeNull()
    expect(panel()?.getAttribute('role')).toBeNull()
    expect(getOverlayFocusOwners()).toEqual([])
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    act(() => {
      composer().dispatchEvent(escape)
    })
    expect(escape.defaultPrevented).toBe(false)
    expect(panel()).not.toBeNull()
    const row = Array.from(panel()!.querySelectorAll<HTMLElement>('[id*="-opt-"]')).find((option) =>
      option.textContent?.includes('prompt 30')
    )!
    await keys.click(row)
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'm29' }))
    expect(document.activeElement).toBe(composer())
    expect(composer().selectionStart).toBe(5)
  })

  it('becomes a focus-mode dialog when the filter is clicked', async () => {
    const keys = user()
    render({ loaded: 30 })
    hoverRail()
    wait(200)
    await keys.click(filter()!)
    expect(panel()?.getAttribute('role')).toBe('dialog')
    expect(getOverlayFocusOwners()).toContain(panel())
    // Pointer leave no longer closes it.
    act(() => {
      fireEvent.pointerOut(container.querySelector('[data-native-chat-rail]')!, {
        pointerType: 'mouse'
      })
    })
    wait(500)
    expect(panel()).not.toBeNull()
  })
})

describe('teardown', () => {
  it.each([
    ['the pane hides', { listEnabled: false }],
    ['a /clear starts', { clearing: true }]
  ])('closes when %s and fires no timer after', (_, change) => {
    render({ loaded: 30 })
    hoverRail()
    wait(200)
    expect(panel()).not.toBeNull()
    hoverRail()
    render({ loaded: 30, ...change })
    expect(panel()).toBeNull()
    wait(1000)
    expect(panel()).toBeNull()
  })
})
