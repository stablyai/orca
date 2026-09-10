// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { projectStructuredItemsToNativeChat } from '../../../../shared/structured-agent-session-projection'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import {
  estimateNativeChatRowHeight,
  NATIVE_CHAT_ROW_GAP_PX,
  nativeChatRowContentMetrics
} from './native-chat-row-height-estimate'

afterEach(cleanup)

const VIEWPORT_PX = 600
const TRANSCRIPT_LENGTH = 200

function marker(index: number): NativeChatMessage {
  return {
    id: `message-${index}`,
    role: 'assistant',
    blocks: [{ type: 'text', text: `marker-${index}` }],
    timestamp: index + 1,
    source: 'transcript'
  }
}

const ROW_PX = estimateNativeChatRowHeight(nativeChatRowContentMetrics(marker(0)), {
  hasReceipt: false,
  hasStatus: false,
  hasTurnDiff: false
})
const ROW_PITCH_PX = ROW_PX + NATIVE_CHAT_ROW_GAP_PX

// The virtualizer measures with `offsetHeight` — not `clientHeight`, not a
// bounding rect — so that is the one thing a DOM without layout has to answer
// for windowing to engage at all. Rows report the height their own estimate
// predicted, which keeps the totals exact and independent of which rows happen
// to have been mounted long enough to be measured.
function stubLayout(): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.hasAttribute('data-native-chat-scroll')) {
        return VIEWPORT_PX
      }
      return this.hasAttribute('data-index') ? ROW_PX : 0
    }
  })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
    }
  }
}

function session(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'ready',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

function list(messages: NativeChatMessage[]): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={session(messages)}
      isWorking={false}
      expandSignal={false}
      fontScale={1}
    />
  )
}

/** Reads the window, and refuses to pass if there is no window to read.
 *
 *  Without this a change to the usability gate would quietly send every case
 *  below down the whole-transcript path, where "fewer rows than messages" is
 *  false but every other assertion still holds. */
function windowState(container: HTMLElement): { totalSize: number; indexes: number[] } {
  const spacer = container.querySelector<HTMLElement>('[data-native-chat-window]')
  if (!spacer) {
    throw new Error('transcript is not windowed: no spacer, every row is mounted')
  }
  const totalSize = Number.parseFloat(spacer.style.height)
  if (!(totalSize > 0)) {
    throw new Error(`transcript reserved no height (${spacer.style.height})`)
  }
  return {
    totalSize,
    indexes: Array.from(container.querySelectorAll<HTMLElement>('[data-index]'))
      .map((row) => Number(row.dataset.index))
      .sort((left, right) => left - right)
  }
}

/** happy-dom fires no scroll event for an assignment to `scrollTop`. */
function scrollTranscript(container: HTMLElement, top: number): void {
  const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
  if (!scroller) {
    throw new Error('no transcript scroll root')
  }
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

describe('windowed transcript', () => {
  let restoreLayout = (): void => {}
  beforeEach(() => {
    restoreLayout = stubLayout()
  })
  afterEach(() => {
    restoreLayout()
  })

  const transcript = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) => marker(index))

  it('mounts a window over the transcript rather than all of it', () => {
    const { container } = render(list(transcript))
    const { indexes } = windowState(container)

    expect(indexes.length).toBeGreaterThan(0)
    expect(indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
    expect(indexes).toContain(0)
    expect(screen.getByText('marker-0')).toBeInTheDocument()
    expect(screen.queryByText(`marker-${TRANSCRIPT_LENGTH - 2}`)).toBeNull()
  })

  // One gap per pair of rows, and none after the last one. The other half of
  // this — that a row's own reservation does not include the gap as well — is
  // pinned on the estimate itself, where it can be seen without layout.
  it('reserves each row once and one gap between each pair', () => {
    const { container } = render(list(transcript))

    expect(windowState(container).totalSize).toBe(
      TRANSCRIPT_LENGTH * ROW_PX + (TRANSCRIPT_LENGTH - 1) * NATIVE_CHAT_ROW_GAP_PX
    )
  })

  it('moves the mounted rows to bracket the offset the reader scrolled to', () => {
    const { container } = render(list(transcript))
    const offset = 5000
    scrollTranscript(container, offset)
    const { indexes } = windowState(container)
    const focused = Math.floor(offset / ROW_PITCH_PX)

    expect(indexes).toContain(focused)
    expect(indexes[0]).toBeLessThanOrEqual(focused)
    expect(indexes.at(-1)).toBeGreaterThanOrEqual(focused)
    expect(indexes).not.toContain(0)
    expect(indexes.length).toBeLessThan(TRANSCRIPT_LENGTH / 4)
  })

  // The live row announces a running tool through `aria-live`, which says nothing
  // from a row that is not in the document.
  it('keeps the newest row mounted after the reader scrolls away from it', () => {
    const { container } = render(list(transcript))
    scrollTranscript(container, 5000)

    expect(windowState(container).indexes).toContain(TRANSCRIPT_LENGTH - 1)
  })

  it('gives no slot to a message that draws nothing', () => {
    const withBlanks = Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      index % 4 === 0
        ? { ...marker(index), blocks: [{ type: 'text' as const, text: '' }] }
        : marker(index)
    )
    const drawn = TRANSCRIPT_LENGTH - TRANSCRIPT_LENGTH / 4
    const { container } = render(list(withBlanks))
    const { totalSize, indexes } = windowState(container)

    expect(totalSize).toBe(drawn * ROW_PX + (drawn - 1) * NATIVE_CHAT_ROW_GAP_PX)
    expect(indexes.at(-1)).toBeLessThanOrEqual(drawn - 1)
  })

  it('still has the tool run open when the row carrying it comes back', () => {
    const withTool = [...transcript]
    withTool[1] = {
      ...marker(1),
      blocks: [
        { type: 'text', text: 'marker-1' },
        { type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }
      ]
    }
    const { container } = render(list(withTool))

    const header = screen.getByRole('button', { name: /1×/ })
    expect(header).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(header)
    expect(screen.getByRole('button', { name: /1×/ })).toHaveAttribute('aria-expanded', 'true')

    scrollTranscript(container, 5000)
    expect(windowState(container).indexes).not.toContain(1)
    expect(screen.queryByRole('button', { name: /1×/ })).toBeNull()

    scrollTranscript(container, 0)
    expect(screen.getByRole('button', { name: /1×/ })).toHaveAttribute('aria-expanded', 'true')
  })
})

// The reveal chain runs message -> tool run -> diff card and lands on a card in
// a DIFFERENT, earlier message than the rollup that was clicked. Under windowing
// that message may not be mounted to be pointed at, so the reveal names it by id
// and the row is pinned into the window until the card can answer for itself.
describe('revealing a diff from a turn rollup', () => {
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

  const patch = '@@ -1 +1 @@\n-before\n+after'
  const items: AgentJournalRenderItem[] = [
    journalItem(
      'user',
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Edit it' }] },
      1
    ),
    journalItem(
      'diff',
      {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
      },
      2
    ),
    ...Array.from({ length: TRANSCRIPT_LENGTH }, (_, index) =>
      journalItem(
        `tail-${index}`,
        { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: `marker-${index}` }] },
        index + 3
      )
    )
  ]

  it('mounts the row a reveal names even when the window has left it behind', () => {
    const scrollTo = vi.fn()
    vi.spyOn(HTMLElement.prototype, 'scrollTo').mockImplementation(scrollTo)
    const { container } = render(
      <NativeChatMessageList
        session={session(projectStructuredItemsToNativeChat(items))}
        journalItems={items}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
    // The rollup rides the turn's last row, which is pinned; the diff it points
    // at is near the top and long gone from the window.
    scrollTranscript(container, 4000)
    expect(screen.queryByText('Edited file')).toBeNull()
    const mountedBefore = windowState(container).indexes.length

    fireEvent.click(screen.getByRole('button', { name: /1 changed file/ }))
    scrollTo.mockClear()
    fireEvent.click(screen.getByRole('button', { name: /src\/a.ts/ }))

    expect(screen.getByText('Edited file')).toBeInTheDocument()
    expect(screen.getByText('after')).toBeInTheDocument()
    expect(scrollTo).toHaveBeenCalled()
    // Pinned, not paged to: the window is still a window.
    expect(windowState(container).indexes.length).toBeLessThanOrEqual(mountedBefore + 2)
  })
})

describe('transcript with no usable scroll root', () => {
  const transcript = Array.from({ length: 40 }, (_, index) => marker(index))

  // Not a degraded mode: this is what runs whenever the scroll root cannot say
  // where the viewport is, and it has to render exactly what the list rendered
  // before windowing existed.
  it('falls back to mounting every row, with no spacer between them and the column', () => {
    const { container } = render(list(transcript))

    expect(container.querySelector('[data-native-chat-window]')).toBeNull()
    expect(container.querySelectorAll('[data-index]')).toHaveLength(0)
    expect(screen.getAllByText(/^marker-/)).toHaveLength(40)
    const column = container.querySelector('.max-w-4xl')
    expect(column?.children).toHaveLength(40)
  })
})
