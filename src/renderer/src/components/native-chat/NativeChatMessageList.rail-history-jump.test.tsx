// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCallback, useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatRailOutlineEntry } from './native-chat-message-rail-items'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import {
  estimateNativeChatRowHeight,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'
import {
  deliverResizes,
  layout,
  marker,
  overrideLayoutProperty,
  scrollTranscript,
  session,
  stubLayout,
  stubResizeObserver
} from './native-chat-windowing-test-harness'

afterEach(cleanup)

const TOTAL = 60
const PAGE = 20
/** The scroll root's top gutter, always present. */
const TOP_GUTTER_PX = 40
/** The "load earlier" row plus the column gap under it, present only while older
 *  history remains — so the page that exhausts history takes it away. */
const OLDER_HISTORY_ROW_PX = 52
/** A ~500ms smooth scroll at 60fps. */
const SMOOTH_SCROLL_FRAMES = 30

function message(index: number): NativeChatMessage {
  return index % 5 === 0
    ? {
        id: `message-${index}`,
        role: 'user',
        blocks: [{ type: 'text', text: `prompt-${index}` }],
        timestamp: index + 1,
        source: 'transcript'
      }
    : marker(index)
}

const HISTORY = Array.from({ length: TOTAL }, (_, index) => message(index))

/** Every row measures exactly as estimated, so nothing but the jump moves the view. */
const ROW_HEIGHT_BY_TEXT = new Map(
  HISTORY.map((entry) => [
    entry.blocks[0]?.type === 'text' ? entry.blocks[0].text : '',
    estimateNativeChatRowHeight(nativeChatRowContentMetrics(entry), {
      hasReceipt: false,
      hasStatus: false,
      hasTurnDiff: false
    })
  ])
)

/** A lane that pages older history in the way the structured lane does: the page
 *  lands, then the returned promise settles. The outline is the unloaded prompts. */
function PagedTranscript({
  holdPage
}: {
  /** Awaited before a page lands, to keep it in flight. */
  holdPage?: () => Promise<void>
}): React.JSX.Element {
  const [loaded, setLoaded] = useState(PAGE)
  const loadEarlier = useCallback(async (): Promise<NativeChatOlderPageResult> => {
    await (holdPage?.() ?? Promise.resolve())
    setLoaded((current) => Math.min(TOTAL, current + PAGE))
    return 'applied'
  }, [holdPage])
  const messages = useMemo(() => HISTORY.slice(TOTAL - loaded), [loaded])
  const railOutline = useMemo<NativeChatRailOutlineEntry[]>(
    () =>
      HISTORY.slice(0, TOTAL - loaded)
        .filter((entry) => entry.role === 'user')
        .map((entry) => ({
          id: entry.id,
          text: entry.blocks[0]?.type === 'text' ? entry.blocks[0].text : '',
          hasImages: false
        })),
    [loaded]
  )
  return (
    <NativeChatMessageList
      session={{ ...session(messages), hasMore: loaded < TOTAL, loadEarlier }}
      railOutline={railOutline}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

/** Chromium's two scroll kinds: an instant write lands at once; a smooth scroll
 *  eases in and out over frames, and any instant write cancels it. Only the
 *  smooth scroll's landing is ever marked as the application's own, so its first
 *  frames — a pixel or two off where it started — reach the list as unmarked. */
function installScrollModel(): { frame: () => void } {
  let animation: { from: number; to: number; step: number } | null = null
  vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function scrollTo(
    this: HTMLElement,
    options?: ScrollToOptions | number
  ): void {
    const top = typeof options === 'object' ? options.top : undefined
    if (top === undefined) {
      return
    }
    if (typeof options === 'object' && options.behavior === 'smooth') {
      animation = { from: this.scrollTop, to: top, step: 0 }
      return
    }
    animation = null
    this.scrollTop = top
  })
  return {
    frame: () => {
      const scroller = document.querySelector<HTMLElement>('[data-native-chat-scroll]')
      if (!scroller || !animation) {
        return
      }
      animation.step += 1
      const t = animation.step / SMOOTH_SCROLL_FRAMES
      const eased = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2
      scroller.scrollTop = animation.from + (animation.to - animation.from) * eased
      if (animation.step >= SMOOTH_SCROLL_FRAMES) {
        animation = null
      }
    }
  }
}

/** The row's own prose, without the timestamp line the row also carries. */
function rowText(row: HTMLElement): string {
  return /(?:prompt|marker)-\d+/.exec(row.querySelector('p')?.textContent ?? '')?.[0] ?? ''
}

// A rail jump scrolls smoothly. Started by a reader following the end — which is
// exactly where paging older history in leaves them — its first frames used to
// re-arm follow and the next one rebased the view, cancelling the jump a few
// pixels from the bottom.
describe('jumping from the rail while following the end', () => {
  let restore: (() => void)[] = []
  let scrollModel: ReturnType<typeof installScrollModel>
  let lastEventScrollTop = 0

  beforeEach(() => {
    const undoLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
    const stubbedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    restore = [
      undoLayout,
      stubResizeObserver(),
      // Rows measure exactly as estimated, so nothing but the jump moves the view.
      overrideLayoutProperty('offsetHeight', {
        get(this: HTMLElement): number {
          const estimated =
            this.dataset.index === undefined ? undefined : ROW_HEIGHT_BY_TEXT.get(rowText(this))
          return estimated ?? stubbedHeight?.get?.call(this) ?? 0
        }
      }),
      // The rail stands down in a narrow pane.
      overrideLayoutProperty('clientWidth', { get: () => 800 }),
      // Rows sit at their `top` inside the spacer, which sits under the chrome.
      overrideLayoutProperty('offsetTop', {
        get(this: HTMLElement): number {
          if (this.hasAttribute('data-native-chat-window')) {
            return layout.aboveTranscriptPx
          }
          return this.dataset.index === undefined ? 0 : Number.parseFloat(this.style.top) || 0
        }
      }),
      overrideLayoutProperty('offsetParent', {
        get(this: HTMLElement): HTMLElement | null {
          if (this.dataset.index !== undefined) {
            return this.closest<HTMLElement>('[data-native-chat-window]')
          }
          return this.parentElement?.closest<HTMLElement>('[data-native-chat-scroll]') ?? null
        }
      })
    ]
    // The older-history row counts only while it sits in the column's flow.
    Object.defineProperty(layout, 'aboveTranscriptPx', {
      configurable: true,
      get: () =>
        TOP_GUTTER_PX +
        (screen.queryByRole('button', { name: /load earlier messages/i })?.closest('.max-w-4xl')
          ? OLDER_HISTORY_ROW_PX
          : 0)
    })
    scrollModel = installScrollModel()
    lastEventScrollTop = 0
  })

  afterEach(() => {
    vi.restoreAllMocks()
    Object.defineProperty(layout, 'aboveTranscriptPx', {
      configurable: true,
      writable: true,
      value: 0
    })
    for (const undo of restore.toReversed()) {
      undo()
    }
  })

  function scroller(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-native-chat-scroll]')
    if (!element) {
      throw new Error('no transcript scroll root')
    }
    return element
  }

  /** One painted frame: layout clamps the offset to the new document, observers
   *  deliver, a smooth scroll advances, any offset change dispatches one scroll
   *  event — whoever made it — and queued callbacks and animation frames run. */
  async function frame(): Promise<void> {
    const element = scroller()
    act(() => {
      // The stubbed setter clamps, so re-writing the offset applies a shrink.
      const offset = element.scrollTop
      element.scrollTop = offset
      deliverResizes()
      scrollModel.frame()
    })
    if (element.scrollTop !== lastEventScrollTop) {
      lastEventScrollTop = element.scrollTop
      fireEvent.scroll(element)
    }
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
  }

  async function settle(frames: number): Promise<void> {
    for (let index = 0; index < frames; index += 1) {
      await frame()
    }
  }

  function distanceFromBottom(): number {
    const element = scroller()
    return element.scrollHeight - element.clientHeight - element.scrollTop
  }

  /** Where the prompt's row sits relative to the top of the viewport. */
  function rowOffsetFromViewportTop(prompt: string): number {
    const row = screen.getByText(prompt).closest<HTMLElement>('[data-index]')
    if (!row) {
      throw new Error(`${prompt} has no mounted row`)
    }
    return layout.aboveTranscriptPx + Number.parseFloat(row.style.top) - scroller().scrollTop
  }

  it.each([
    ['in the page that exhausts older history', 'prompt-5', false],
    ['in a page with older history still behind it', 'prompt-25', false],
    ['that is already loaded', 'prompt-45', true]
  ])('lands on a message %s', async (_case, prompt, loaded) => {
    render(<PagedTranscript />)
    await settle(10)
    // Anti-vacuous: the reader starts pinned to the very end.
    expect(distanceFromBottom()).toBe(0)
    expect(screen.queryByText(prompt) !== null).toBe(loaded)

    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    await frame()
    fireEvent.click(screen.getByRole('button', { name: prompt }))
    await settle(60)

    // The failure mode: the jump cancelled itself a few pixels above the end.
    expect(distanceFromBottom()).toBeGreaterThan(100)
    expect(Math.abs(rowOffsetFromViewportTop(prompt))).toBeLessThanOrEqual(2)
  })

  it('lets a later pick of a loaded message win over a jump still paging', async () => {
    let releaseFirstPage: (() => void) | null = null
    let held = false
    const holdPage = (): Promise<void> => {
      if (held) {
        return Promise.resolve()
      }
      held = true
      return new Promise<void>((resolve) => {
        releaseFirstPage = resolve
      })
    }
    render(<PagedTranscript holdPage={holdPage} />)
    await settle(10)

    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    await frame()
    fireEvent.click(screen.getByRole('button', { name: 'prompt-5' }))
    await frame()
    // Anti-vacuous: the older page is in flight.
    expect(releaseFirstPage).not.toBeNull()
    // The list stays open while the pick pages in, so the reader picks again in place.
    fireEvent.click(screen.getByRole('button', { name: 'prompt-45' }))
    await settle(40)
    act(() => releaseFirstPage?.())
    await settle(60)

    // The superseded jump would have kept paging and pulled the reader to prompt-5.
    expect(screen.queryByText('prompt-5')).toBeNull()
    expect(Math.abs(rowOffsetFromViewportTop('prompt-45'))).toBeLessThanOrEqual(2)
  })
  /** Holds the first older page in flight until released; later pages land at once. */
  function holdFirstPage(): {
    holdPage: () => Promise<void>
    release: () => void
    asked: () => number
  } {
    let release: (() => void) | null = null
    let asked = 0
    return {
      holdPage: () => {
        asked += 1
        return asked > 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              release = resolve
            })
      },
      release: () => act(() => release?.()),
      asked: () => asked
    }
  }

  async function pickUnloadedWhilePaging(prompt: string): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    await frame()
    fireEvent.click(screen.getByRole('button', { name: prompt }))
    await frame()
  }

  it('keeps the list open with the pick marked busy until its history lands', async () => {
    const pages = holdFirstPage()
    render(<PagedTranscript holdPage={pages.holdPage} />)
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)

    // The failure mode: picking closed the list, so the busy item was never seen.
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'prompt-5' }).getAttribute('aria-busy')).toBe('true')

    pages.release()
    await settle(60)

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(Math.abs(rowOffsetFromViewportTop('prompt-5'))).toBeLessThanOrEqual(2)
  })

  it.each([
    ['a wheel over the transcript', () => fireEvent.wheel(scroller(), { deltaY: -40 })],
    ['a scroll key', () => fireEvent.keyDown(scroller(), { key: 'PageUp' })],
    ['a touch drag', () => fireEvent.touchMove(scroller())],
    ['a scrollbar grab', () => fireEvent.pointerDown(scroller())]
  ])('leaves the reader where they are after %s while the jump pages', async (_case, input) => {
    const pages = holdFirstPage()
    render(<PagedTranscript holdPage={pages.holdPage} />)
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    // Anti-vacuous: the older page is in flight.
    expect(pages.asked()).toBe(1)

    expect(screen.getByRole('button', { name: 'prompt-5' }).getAttribute('aria-busy')).toBe('true')

    input()
    await frame()
    // Abandoning the jump settles the pick: nothing is left pulsing in an open list.
    expect(screen.queryByRole('dialog')).toBeNull()
    pages.release()
    await settle(60)

    // The abandoned jump would have paged on and pulled the reader up to prompt-5.
    expect(pages.asked()).toBe(1)
    expect(screen.queryByText('prompt-5')).toBeNull()
    expect(distanceFromBottom()).toBe(0)
  })

  it('leaves the reader where they are after a wheel over the rail while the jump pages', async () => {
    const pages = holdFirstPage()
    render(<PagedTranscript holdPage={pages.holdPage} />)
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)

    // The rail forwards its wheel to the transcript: the reader is scrolling.
    fireEvent.wheel(screen.getByRole('button', { name: 'Your messages' }), { deltaY: -40 })
    await frame()
    // Anti-vacuous: the wheel moved the transcript.
    expect(distanceFromBottom()).toBe(40)
    pages.release()
    await settle(60)

    expect(pages.asked()).toBe(1)
    expect(screen.queryByText('prompt-5')).toBeNull()
    expect(distanceFromBottom()).toBe(40)
  })

  it('keeps paging when the reader wheels the open message list', async () => {
    const pages = holdFirstPage()
    render(<PagedTranscript holdPage={pages.holdPage} />)
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)

    // The list scrolls itself; the transcript is not being read.
    fireEvent.wheel(screen.getByRole('dialog'), { deltaY: -40 })
    pages.release()
    await settle(60)

    expect(pages.asked()).toBeGreaterThan(1)
    expect(Math.abs(rowOffsetFromViewportTop('prompt-5'))).toBeLessThanOrEqual(2)
  })

  it('stays at the latest message when "Jump to latest" is pressed while the jump pages', async () => {
    const pages = holdFirstPage()
    render(<PagedTranscript holdPage={pages.holdPage} />)
    await settle(10)
    // A reader parked above the end, so the button shows.
    act(() => {
      scroller().scrollTop = 200
    })
    await settle(2)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)

    fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }))
    await frame()
    pages.release()
    await settle(60)

    expect(pages.asked()).toBe(1)
    expect(screen.queryByText('prompt-5')).toBeNull()
    expect(distanceFromBottom()).toBe(0)
  })
})

describe('revealing a diff while a rail jump pages', () => {
  let restoreLayout = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    restoreLayout()
    vi.restoreAllMocks()
  })

  function journalItem(itemId: string, body: AgentJournalItemBody, sequence: number) {
    return { itemId, body, sequence, observedAt: sequence * 1000, revision: 1 }
  }
  function prompt(itemId: string, text: string, sequence: number) {
    return journalItem(
      itemId,
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] },
      sequence
    )
  }

  const patch = '@@ -1 +1 @@\n-before\n+after'
  const OLDER = prompt('older', 'Oldest prompt', 1)
  const LOADED: AgentJournalRenderItem[] = [
    prompt('user', 'Edit it', 2),
    journalItem(
      'diff',
      {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
      },
      3
    ),
    prompt('user-2', 'Second prompt', 4),
    prompt('user-3', 'Third prompt', 5),
    ...Array.from({ length: 200 }, (_, index) =>
      journalItem(
        `tail-${index}`,
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `marker-${index}` }] },
        index + 6
      )
    )
  ]

  function DiffTranscript({ holdPage }: { holdPage: () => Promise<void> }): React.JSX.Element {
    const [loadedOlder, setLoadedOlder] = useState(false)
    const items = useMemo(() => (loadedOlder ? [OLDER, ...LOADED] : LOADED), [loadedOlder])
    const loadEarlier = useCallback(async (): Promise<NativeChatOlderPageResult> => {
      await holdPage()
      setLoadedOlder(true)
      return 'applied'
    }, [holdPage])
    return (
      <NativeChatMessageList
        session={{
          ...session(projectStructuredItemsToNativeChat(items)),
          hasMore: !loadedOlder,
          loadEarlier
        }}
        journalItems={items}
        railOutline={loadedOlder ? [] : [{ id: 'older', text: 'Oldest prompt', hasImages: false }]}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
  }

  it('keeps the diff in view when its page lands', async () => {
    let release = (): void => {}
    const holdPage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    const { container } = render(<DiffTranscript holdPage={holdPage} />)

    fireEvent.click(screen.getByRole('button', { name: 'Your messages' }))
    fireEvent.click(screen.getByRole('button', { name: 'Oldest prompt' }))
    // Anti-vacuous: the older page is in flight.
    expect(holdPage).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
    scrollTranscript(container, 6000)
    expect(screen.getByText('Edited file')).toBeInTheDocument()
    scrollTo.mockClear()

    await act(async () => {
      release()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })

    // The abandoned jump would have taken the pin and smooth-scrolled up to the oldest
    // prompt; the prepend's own anchoring is an instant write.
    expect(scrollTo.mock.calls.filter(([options]) => options?.behavior === 'smooth')).toEqual([])
    expect(screen.getByText('Edited file')).toBeInTheDocument()
  })
})
