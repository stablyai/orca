// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useLayoutEffect, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatViewIdentity, retireNativeChatViewState } from './native-chat-view-state-memory'
import { NativeChatFindBar } from './NativeChatFindBar'
import { useNativeChatFind } from './use-native-chat-find'
import { useNativeChatRevealLatest } from './use-native-chat-reveal-latest'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'

vi.mock('../../store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function findInput(): HTMLInputElement | null {
  return screen.queryByRole<HTMLInputElement>('textbox', { name: 'Find in chat' })
}
function typeQuery(value: string): void {
  fireEvent.change(findInput()!, { target: { value } })
}
function status(): string | null | undefined {
  return findInput()?.parentElement?.querySelector('[aria-live]')?.textContent
}
async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}
function press(target: EventTarget, key: string): void {
  act(() =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  )
}
const noop = (): void => {}

/** Uses the real reader receiver; the producer exists while its transcript is absent. */
function FindFlow({
  attached = true,
  text = 'needle needle needle',
  epoch = 'e',
  onTake = noop,
  column = true,
  onFind
}: {
  attached?: boolean
  text?: string
  epoch?: string
  onTake?: () => void
  column?: boolean
  onFind?: (delivered: boolean) => void
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef(null)
  const reveal = useNativeChatRevealLatest(epoch)
  const { messageListRef, revealLatest } = reveal
  const find = useNativeChatFind(true, rootRef, composerRef, reveal)
  const reader = useNativeChatReaderScrollInput(scrollRef, {
    onReaderScroll: find.cancelNavigation,
    onTakeScroll: onTake,
    onLeaveEnd: () => {},
    onScrollGesture: () => {}
  })
  const { revealFindMatch, beginNavigation } = reader
  useLayoutEffect(() => {
    if (scrollRef.current) {
      Object.defineProperties(scrollRef.current, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 2000 },
        getBoundingClientRect: {
          configurable: true,
          value: () => DOMRect.fromRect({ width: 500, height: 100 })
        }
      })
    }
    messageListRef.current = attached
      ? {
          revealFindMatch: (...args) => {
            const delivered = revealFindMatch(...args)
            onFind?.(delivered)
            return delivered
          },
          revealLatest: beginNavigation,
          messageCopyText: () => null
        }
      : null
    return () => {
      messageListRef.current = null
    }
  }, [attached, messageListRef, revealFindMatch, beginNavigation, onFind])
  return (
    <div ref={rootRef} data-native-chat-root onKeyDownCapture={find.onKeyDownCapture}>
      <button onClick={() => find.open?.()}>Open</button>
      <button onClick={revealLatest}>Latest</button>
      {find.isOpen && <NativeChatFindBar find={find} isVisible />}
      {attached && (
        <div ref={scrollRef} data-native-chat-scroll {...reader.scrollerProps}>
          {column && (
            <div data-native-chat-transcript-column>
              <p data-native-chat-row-key="row">{text}</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

it('keeps an accepted loading query through park, completes once at attachment, then returns passively and steps from the same match', async () => {
  const take = vi.fn()
  vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
    const scroll = document.querySelector('[data-native-chat-scroll]')?.scrollTop ?? 0
    return DOMRect.fromRect({
      x: 20,
      y: 200 + this.startOffset * 15 - scroll,
      width: 30,
      height: 15
    })
  })
  const key = 'pending-find-return'
  const ui = (attached: boolean, text?: string) => (
    <NativeChatViewIdentity value={key}>
      <FindFlow attached={attached} onTake={take} {...(text === undefined ? {} : { text })} />
    </NativeChatViewIdentity>
  )
  const first = render(ui(false))
  fireEvent.click(screen.getByText('Open'))
  typeQuery('needle')
  first.unmount()
  const returned = render(ui(false))
  returned.rerender(ui(true))
  await nextFrame()
  expect(status()).toBe('1/3')
  expect(take).toHaveBeenCalledTimes(1)
  press(findInput()!, 'Enter')
  expect(status()).toBe('2/3')
  returned.unmount()
  const passive = render(ui(true))
  expect(status()).toBe('2/3')
  expect(take).toHaveBeenCalledTimes(2)
  expect(passive.container.querySelector('[data-native-chat-scroll]')?.scrollTop).toBe(0)
  fireEvent.click(screen.getByText('Open'))
  expect(status()).toBe('2/3')
  press(findInput()!, 'Enter')
  expect(status()).toBe('3/3')
  // Attached no-match is completion, not a future streamed reveal.
  typeQuery('later')
  expect(status()).toBe('No results')
  passive.rerender(ui(true, 'later later'))
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150))
  })
  expect(status()).toBe('2/2')
  expect(take).toHaveBeenCalledTimes(3)
  passive.unmount()
  retireNativeChatViewState(key)
})

it('supersedes an uncompleted search at accepted latest even without a list, and a reader gesture beats a scheduled query search', async () => {
  const take = vi.fn()
  const key = 'find-supersession'
  const ui = (attached: boolean) => (
    <NativeChatViewIdentity value={key}>
      <FindFlow attached={attached} onTake={take} column={false} />
    </NativeChatViewIdentity>
  )
  const view = render(ui(false))
  fireEvent.click(screen.getByText('Open'))
  typeQuery('needle')
  fireEvent.click(screen.getByText('Latest'))
  view.rerender(ui(true))
  await nextFrame()
  expect(status()).toBe('No results')
  expect(take).not.toHaveBeenCalled()
  // The actual receiver claims in-view/clamped navigation, but an absent one cannot.
  const input = findInput()!
  typeQuery('different')
  typeQuery('needle')
  const scroller = view.container.querySelector('[data-native-chat-scroll]')!
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  vi.stubGlobal('cancelAnimationFrame', () => {})
  const content = document.createElement('div')
  content.setAttribute('data-native-chat-transcript-column', '')
  content.innerHTML = '<p data-native-chat-row-key="row">needle needle</p>'
  scroller.append(content)
  await act(async () => {})
  fireEvent.wheel(scroller, { deltaY: 20 })
  act(() => {
    for (const callback of frames.splice(0)) {
      callback(0)
    }
  })
  expect(take).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(findInput()).toBeNull()
  view.unmount()
  const returned = render(ui(true))
  expect(findInput()).toBeNull()
  returned.unmount()
  retireNativeChatViewState(key)
})

it('derives retained row locators with one Map get/set per eligible occurrence at N and 10N', () => {
  const get = Map.prototype.get
  const set = Map.prototype.set
  for (const size of [10, 100]) {
    let gets = 0
    let sets = 0
    const getSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown
    ) {
      if (key === 'row') {
        gets++
      }
      return get.call(this, key)
    })
    const setSpy = vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown
    ) {
      if (key === 'row') {
        sets++
      }
      return set.call(this, key, value)
    })
    const view = render(<FindFlow text={'needle '.repeat(size)} />)
    fireEvent.click(screen.getByText('Open'))
    typeQuery('needle')
    expect(status()).toBe(`1/${size}`)
    expect(gets).toBe(size)
    expect(sets).toBe(size)
    view.unmount()
    getSpy.mockRestore()
    setSpy.mockRestore()
  }
})

it('completes empty-query attachment once and does no passive matching work for later content changes', async () => {
  const take = vi.fn()
  const delivered = vi.fn()
  const view = render(<FindFlow column={false} onTake={take} onFind={delivered} />)
  fireEvent.click(screen.getByText('Open'))
  const scroll = view.container.querySelector('[data-native-chat-scroll]')!
  const column = document.createElement('div')
  column.setAttribute('data-native-chat-transcript-column', '')
  scroll.append(column)
  await nextFrame()
  expect(delivered).toHaveBeenCalledExactlyOnceWith(true)
  expect(take).not.toHaveBeenCalled()
  const query = vi.spyOn(view.container.querySelector('[data-native-chat-root]')!, 'querySelector')
  for (const size of [10, 100]) {
    column.textContent = 'needle '.repeat(size)
    await nextFrame()
    expect(
      query.mock.calls.filter(([selector]) => selector === '[data-native-chat-transcript-column]')
    ).toHaveLength(0)
  }
  typeQuery('needle')
  expect(status()).toBe('1/100')
})
