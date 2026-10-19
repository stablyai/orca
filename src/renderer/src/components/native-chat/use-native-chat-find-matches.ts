import { useCallback, useEffect, useRef, useState } from 'react'
import {
  createDomTextSearchHighlights,
  findDomTextSearchRanges,
  type DomTextSearchInstance,
  type DomTextSearchScope
} from '@/lib/dom-text-search-highlights'
import { nativeChatFindGeometry } from './native-chat-find-visibility'

// Must match the ::highlight() selectors in native-chat-find.css.
const chatFindHighlights = createDomTextSearchHighlights({
  match: 'native-chat-find-match',
  active: 'native-chat-find-active-match'
})

const TRANSCRIPT_COLUMN_SELECTOR = '[data-native-chat-transcript-column]'
const TRANSCRIPT_SCROLL_SELECTOR = '[data-native-chat-scroll]'
/** Row chrome that only shows on hover (timestamps, copy): marked, so counts never follow the mouse. */
const SKIPPED_TEXT_SELECTOR = '.sr-only, [hidden], [data-native-chat-find-skip]'
/** A streamed reply's text node while its words fade in: each new word is its own element. */
const WORD_GROUP_SELECTOR = '[data-word-group]'
/** Streamed text with no match in it grows every frame; re-searching it this often is plenty. */
const TEXT_GROWTH_SEARCH_DELAY_MS = 120

/** Text growing in place: a text node rewritten, or words drawn into or settled in a word group. */
function isTextGrowth(record: MutationRecord): boolean {
  return (
    record.type === 'characterData' ||
    (record.type === 'childList' &&
      record.target instanceof Element &&
      record.target.matches(WORD_GROUP_SELECTOR))
  )
}

function holdsMatch(node: Node, matchNodes: ReadonlySet<Node>): boolean {
  return (
    matchNodes.has(node) ||
    Array.from(node.childNodes).some((child) => holdsMatch(child, matchNodes))
  )
}

function visibleTextScope(reuse: Range[]): DomTextSearchScope {
  const rejected = new Map<HTMLElement, boolean>()
  return {
    rejectElement: (element) => {
      let reject = rejected.get(element)
      if (reject === undefined) {
        reject =
          element.closest(SKIPPED_TEXT_SELECTOR) !== null ||
          (typeof element.checkVisibility === 'function' &&
            !element.checkVisibility({ visibilityProperty: true }))
        rejected.set(element, reject)
      }
      return reject
    },
    // Highlighted code and fading reply words split text into spans; match across them.
    joinedTextSelector: `code, ${WORD_GROUP_SELECTOR}`,
    reuse
  }
}

type MatchAnchor = { node: Node; offset: number }

function anchorOf(range: Range | undefined): MatchAnchor | null {
  return range ? { node: range.startContainer, offset: range.startOffset } : null
}

/** The first match the reader can see; else the first below the view; else the last. */
function firstVisibleMatch(
  matches: readonly Range[],
  scroller: Element | null,
  bar: DOMRectReadOnly | null
): { index: number; inView: boolean } {
  if (matches.length === 0) {
    return { index: -1, inView: false }
  }
  if (!scroller) {
    return { index: 0, inView: false }
  }
  const geometry = nativeChatFindGeometry(scroller)
  const viewTop = scroller.getBoundingClientRect().top
  let below = -1
  for (const [index, match] of matches.entries()) {
    const rect = match.getBoundingClientRect()
    if (rect.bottom < viewTop) {
      continue
    }
    if (geometry.inView(match, bar)) {
      return { index, inView: true }
    }
    if (below === -1 && rect.top >= viewTop) {
      below = index
    }
  }
  return { index: below === -1 ? matches.length - 1 : below, inView: false }
}

/** After the transcript changed: the same match if it survived, else the next one after it. */
function survivingMatchIndex(matches: readonly Range[], anchor: MatchAnchor): number {
  const exact = matches.findIndex(
    (match) => match.startContainer === anchor.node && match.startOffset === anchor.offset
  )
  if (exact !== -1) {
    return exact
  }
  const point = document.createRange()
  point.setStart(anchor.node, Math.min(anchor.offset, anchor.node.textContent?.length ?? 0))
  const after = matches.findIndex(
    (match) => match.compareBoundaryPoints(Range.START_TO_START, point) >= 0
  )
  return after === -1 ? matches.length - 1 : after
}

export type NativeChatFindMatches = {
  matchCount: number
  /** -1 when there is no match. */
  activeIndex: number
  step: (direction: 1 | -1) => void
}

/** Searches the chat transcript's DOM and keeps the matches current while it streams and scrolls. */
export function useNativeChatFindMatches({
  rootRef,
  barRef,
  query,
  isVisible,
  revealMatch
}: {
  rootRef: React.RefObject<HTMLDivElement | null>
  barRef: React.RefObject<HTMLElement | null>
  query: string
  isVisible: boolean
  revealMatch: (match: Range) => void
}): NativeChatFindMatches {
  const [instance] = useState<DomTextSearchInstance>(() => ({}))
  const [matchCount, setMatchCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(-1)
  const matchesRef = useRef<readonly Range[]>([])
  const activeIndexRef = useRef(-1)
  const anchorRef = useRef<MatchAnchor | null>(null)
  const searchedQueryRef = useRef<string | null>(null)
  // Text nodes holding a match: React rewrites a growing node whole, which collapses its ranges.
  const matchNodesRef = useRef<ReadonlySet<Node>>(new Set())

  const activate = useCallback(
    (matches: readonly Range[], index: number) => {
      activeIndexRef.current = index
      anchorRef.current = anchorOf(matches[index])
      chatFindHighlights.setActive(instance, matches[index])
      setActiveIndex(index)
    },
    [instance]
  )

  const search = useCallback(() => {
    const root = rootRef.current
    const column = root?.querySelector<HTMLElement>(TRANSCRIPT_COLUMN_SELECTOR)
    const scroller = root?.querySelector(TRANSCRIPT_SCROLL_SELECTOR) ?? null
    const found = column
      ? findDomTextSearchRanges(column, query, visibleTextScope([...matchesRef.current]))
      : []
    const geometry = scroller ? nativeChatFindGeometry(scroller) : null
    const matches = geometry ? found.filter((match) => !geometry.clippedAway(match)) : found
    const newQuery = searchedQueryRef.current !== query
    searchedQueryRef.current = query
    matchesRef.current = matches
    matchNodesRef.current = new Set(
      matches.flatMap((match) => [match.startContainer, match.endContainer])
    )
    chatFindHighlights.setMatches(instance, matches)
    setMatchCount(matches.length)
    const anchor = anchorRef.current
    if (!newQuery && matches.length > 0 && anchor?.node.isConnected) {
      activate(matches, survivingMatchIndex(matches, anchor))
      return
    }
    // A new query, or the active match's row scrolled out of the window: start from what is on screen.
    const bar = barRef.current?.getBoundingClientRect() ?? null
    const first = firstVisibleMatch(matches, scroller, bar)
    activate(matches, first.index)
    if (newQuery && first.index !== -1 && !first.inView) {
      revealMatch(matches[first.index])
    }
  }, [activate, barRef, instance, query, revealMatch, rootRef])

  useEffect(() => {
    const root = rootRef.current
    if (!isVisible || !root) {
      return
    }
    search()
    if (!query || typeof MutationObserver === 'undefined') {
      return
    }
    let frame: number | null = null
    let timer: ReturnType<typeof setTimeout> | null = null
    const runSearch = (): void => {
      if (frame !== null) {
        cancelAnimationFrame(frame)
        frame = null
      }
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
      search()
    }
    let column = root.querySelector(TRANSCRIPT_COLUMN_SELECTOR)
    const observer = new MutationObserver((records) => {
      const current = root.querySelector(TRANSCRIPT_COLUMN_SELECTOR)
      const changed = records.filter((record) => current?.contains(record.target))
      const replaced = current !== column
      column = current
      if (!replaced && changed.length === 0) {
        return
      }
      // Rows mounting or opening, and text that held a match (its ranges just collapsed), are
      // re-searched before the next paint; other text growing in place can wait.
      const now =
        replaced ||
        changed.some(
          (record) =>
            !isTextGrowth(record) ||
            matchNodesRef.current.has(record.target) ||
            Array.from(record.removedNodes).some((node) => holdsMatch(node, matchNodesRef.current))
        )
      if (now) {
        frame ??= requestAnimationFrame(runSearch)
      } else {
        timer ??= setTimeout(runSearch, TEXT_GROWTH_SEARCH_DELAY_MS)
      }
    })
    // A disclosure opens with a height animation (not a mutation): what it cut off at first shows at its end.
    const onAnimationEnd = (event: Event): void => {
      if (event.target instanceof Node && column?.contains(event.target)) {
        frame ??= requestAnimationFrame(runSearch)
      }
    }
    root.addEventListener('animationend', onAnimationEnd)
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      // Disclosures; row positioning writes `style` on every scroll and is not a content change.
      attributeFilter: ['hidden', 'open', 'data-state']
    })
    return () => {
      observer.disconnect()
      root.removeEventListener('animationend', onAnimationEnd)
      if (frame !== null) {
        cancelAnimationFrame(frame)
      }
      if (timer !== null) {
        clearTimeout(timer)
      }
    }
  }, [isVisible, query, rootRef, search])

  useEffect(() => () => chatFindHighlights.clear(instance), [instance])

  const step = useCallback(
    (direction: 1 | -1) => {
      // A row that unmounted since the last search leaves collapsed ranges: refresh first.
      if (matchesRef.current.some((match) => match.collapsed)) {
        search()
      }
      const matches = matchesRef.current
      if (matches.length === 0) {
        return
      }
      const current = activeIndexRef.current
      const index =
        current < 0
          ? direction > 0
            ? 0
            : matches.length - 1
          : (current + direction + matches.length) % matches.length
      activate(matches, index)
      revealMatch(matches[index])
    },
    [activate, revealMatch, search]
  )

  return { matchCount, activeIndex, step }
}
