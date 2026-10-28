// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useCallback, useMemo, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { transcriptRowOffset, transcriptWindowTop } from './native-chat-window-test-layout'
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
  session,
  stubLayout,
  stubResizeObserver
} from './native-chat-windowing-test-harness'

afterEach(cleanup)

const TOTAL = 60
const PAGE = 20
/** The scroll root's top gutter, always present. */
const TOP_GUTTER_PX = 40
/** In-flow older-history chrome disappears with the last page. */
const OLDER_HISTORY_ROW_PX = 52

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

/** Publish each page before settling its promise; the outline also includes unloaded prompts. */
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
    />
  )
}

function rowText(row: HTMLElement): string {
  return /(?:prompt|marker)-\d+/.exec(row.querySelector('p')?.textContent ?? '')?.[0] ?? ''
}

// A jump must detach end-follow and retain its landing as older history arrives.
describe('jumping from the rail while following the end', () => {
  let restore: (() => void)[] = []
  let lastEventScrollTop = 0

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: [
        'Date',
        'performance',
        'setTimeout',
        'clearTimeout',
        'requestAnimationFrame',
        'cancelAnimationFrame'
      ]
    })
    const undoLayout = stubLayout({ scrollGeometry: true, offsetChain: true })
    const stubbedHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    restore = [
      undoLayout,
      stubResizeObserver(),
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
          return this.dataset.index === undefined ? 0 : transcriptRowOffset(this)
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
        transcriptWindowTop(
          document.querySelector('[data-native-chat-window]'),
          TOP_GUTTER_PX,
          OLDER_HISTORY_ROW_PX
        )
    })
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(function scrollTo(
      this: HTMLElement,
      options?: ScrollToOptions | number
    ): void {
      if (typeof options === 'object' && options.top !== undefined) {
        this.scrollTop = options.top
      }
    })
    lastEventScrollTop = 0
  })

  afterEach(() => {
    vi.useRealTimers()
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

  /** Deliver layout changes and scroll events before the virtualizer's next frame. */
  async function frame(): Promise<void> {
    const element = scroller()
    act(() => {
      // The stubbed setter clamps, so re-writing the offset applies a shrink.
      const offset = element.scrollTop
      element.scrollTop = offset
      deliverResizes()
    })
    if (element.scrollTop !== lastEventScrollTop) {
      lastEventScrollTop = element.scrollTop
      fireEvent.scroll(element)
    }
    await act(async () => {
      vi.advanceTimersByTime(16)
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

  function rowOffsetFromViewportTop(prompt: string): number {
    const row = screen.getByText(prompt).closest<HTMLElement>('[data-index]')
    if (!row) {
      throw new Error(`${prompt} has no mounted row`)
    }
    return layout.aboveTranscriptPx + row.offsetTop - scroller().scrollTop
  }

  it.each([
    ['in the page that exhausts older history', 'prompt-5', false],
    ['in a page with older history still behind it', 'prompt-25', false],
    ['that is already loaded', 'prompt-45', true]
  ])('jumps without animation to a message %s', async (_case, prompt, loaded) => {
    render(<PagedTranscript />)
    await settle(10)
    expect(distanceFromBottom()).toBe(0)
    expect(screen.queryByText(prompt) !== null).toBe(loaded)

    fireEvent.click(screen.getByRole('button', { name: prompt }))
    if (loaded) {
      expect(Math.abs(rowOffsetFromViewportTop(prompt))).toBeLessThanOrEqual(2)
      await frame()
      expect(Math.abs(rowOffsetFromViewportTop(prompt))).toBeLessThanOrEqual(2)
    }
    await settle(loaded ? 59 : 60)

    expect(HTMLElement.prototype.scrollTo).toHaveBeenCalled()
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalledWith(
      expect.objectContaining({ behavior: 'smooth' })
    )
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

    fireEvent.click(screen.getByRole('button', { name: 'prompt-5' }))
    await frame()
    expect(releaseFirstPage).not.toBeNull()
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
    fireEvent.click(screen.getByRole('button', { name: prompt }))
    await frame()
  }

  it('marks the pick busy until its history lands', async () => {
    const pages = holdFirstPage()
    render(<PagedTranscript holdPage={pages.holdPage} />)
    await settle(10)
    await pickUnloadedWhilePaging('prompt-5')
    expect(pages.asked()).toBe(1)

    expect(screen.getByRole('button', { name: 'prompt-5' }).getAttribute('aria-busy')).toBe('true')

    pages.release()
    await settle(60)

    expect(screen.getByRole('button', { name: 'prompt-5' }).getAttribute('aria-busy')).toBeNull()
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
    expect(pages.asked()).toBe(1)

    expect(screen.getByRole('button', { name: 'prompt-5' }).getAttribute('aria-busy')).toBe('true')

    input()
    await frame()
    expect(screen.getByRole('button', { name: 'prompt-5' }).getAttribute('aria-busy')).toBeNull()
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
    fireEvent.wheel(screen.getByRole('toolbar', { name: 'Your messages' }), { deltaY: -40 })
    await frame()
    expect(distanceFromBottom()).toBe(40)
    pages.release()
    await settle(60)

    expect(pages.asked()).toBe(1)
    expect(screen.queryByText('prompt-5')).toBeNull()
    expect(distanceFromBottom()).toBe(40)
  })

  it('stays at the latest message when "Jump to latest" is pressed while the jump pages', async () => {
    const pages = holdFirstPage()
    render(<PagedTranscript holdPage={pages.holdPage} />)
    await settle(10)
    // A reader parked above the end, so the button shows.
    act(() => {
      fireEvent.wheel(scroller(), { deltaY: -100 })
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

  describe('revealing a diff while a rail jump pages', () => {
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
      ...Array.from({ length: 200 }, (_, index) =>
        journalItem(
          `tail-${index}`,
          {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: `marker-${index}` }]
          },
          index + 4
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
          railOutline={
            loadedOlder ? [] : [{ id: 'older', text: 'Oldest prompt', hasImages: false }]
          }
          isWorking={false}
          expandSignal={false}
        />
      )
    }

    function expectDiffInView(): void {
      expect(
        screen.getByRole('button', { name: /^Edited .*a\.ts(?:\s|$)/, expanded: true })
      ).toBeInTheDocument()
      const row = screen.getByText('Edited').closest<HTMLElement>('[data-index]')
      if (!row) {
        throw new Error('revealed diff has no mounted row')
      }
      const top = layout.aboveTranscriptPx + row.offsetTop - scroller().scrollTop
      expect(row.offsetHeight).toBeGreaterThan(0)
      expect(top).toBeGreaterThanOrEqual(-2)
      expect(top).toBeLessThan(scroller().clientHeight - 2)
    }

    it('keeps the diff in view when its page lands', async () => {
      const pages = holdFirstPage()
      render(<DiffTranscript holdPage={pages.holdPage} />)
      await settle(10)
      expect(distanceFromBottom()).toBe(0)
      expect(screen.queryByText('Edited')).toBeNull()

      await pickUnloadedWhilePaging('Oldest prompt')
      expect(pages.asked()).toBe(1)
      expect(screen.getByRole('button', { name: 'Oldest prompt' })).toHaveAttribute(
        'aria-busy',
        'true'
      )

      fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
      fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))
      expect(screen.getByRole('button', { name: 'Oldest prompt' })).not.toHaveAttribute('aria-busy')
      await settle(40)
      expectDiffInView()

      pages.release()
      await settle(60)

      expect(pages.asked()).toBe(1)
      expect(screen.getByRole('button', { name: 'Oldest prompt' })).not.toHaveAttribute('aria-busy')
      expectDiffInView()
    })
  })
})
