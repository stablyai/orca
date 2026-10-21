import { findTextMatchRanges, isTextSearchQueryTooLarge } from './text-match-ranges'

// Why: React owns the searched DOM. Injecting <mark> by splitting its text nodes
// left React holding stale child pointers (NotFoundError on the next commit), so
// matches are painted with the CSS Custom Highlight API, which highlights Ranges
// without mutating the DOM.

type HighlightApi = {
  registry: HighlightRegistry
  create: (ranges: readonly Range[]) => Highlight
}

// Degrades to a no-op where the API is absent (older Chromium, jsdom/happy-dom in
// tests) — match counting and navigation still work off the returned Ranges; only
// the paint is skipped.
function getHighlightApi(): HighlightApi | null {
  if (
    typeof Highlight !== 'function' ||
    typeof CSS === 'undefined' ||
    !('highlights' in CSS) ||
    !CSS.highlights
  ) {
    return null
  }
  return {
    registry: CSS.highlights,
    // Why: build with .add() rather than new Highlight(...ranges). A big doc +
    // short query yields 100k+ ranges, and spreading that many constructor
    // args overflows V8's argument stack (RangeError).
    create: (ranges) => {
      const highlight = new Highlight()
      for (const range of ranges) {
        highlight.add(range)
      }
      return highlight
    }
  }
}

declare const domTextSearchInstanceBrand: unique symbol

/** Per-surface identity for the highlight maps; only compared by reference. */
export type DomTextSearchInstance = {
  readonly [domTextSearchInstanceBrand]?: never
}

/** The ::highlight() names one kind of search surface paints into. */
export type DomTextSearchHighlightNames = {
  readonly match: string
  readonly active: string
}

export type DomTextSearchHighlights = {
  /** Replaces this instance's matches and drops its active match. */
  setMatches: (instance: DomTextSearchInstance, ranges: readonly Range[]) => void
  setActive: (instance: DomTextSearchInstance, range: Range | undefined) => void
  clear: (instance: DomTextSearchInstance) => void
}

// Avoid array spread when collecting union ranges — a large doc can produce
// 100k+ ranges and create()/registry writes must not build variadic arg lists.
function paintUnion(api: HighlightApi, name: string, ranges: Iterable<Range>): void {
  const union: Range[] = []
  for (const range of ranges) {
    union.push(range)
  }
  if (union.length > 0) {
    api.registry.set(name, api.create(union))
  } else {
    api.registry.delete(name)
  }
}

function* flatten(groups: Iterable<readonly Range[]>): Iterable<Range> {
  for (const group of groups) {
    yield* group
  }
}

/**
 * CSS.highlights is a document-global registry keyed by a static name, while several
 * surfaces of one kind can search at once (split panes, a floating window). Each
 * instance's ranges are tracked by its own token and the UNION is painted, so one
 * surface's find does not clobber another's.
 */
export function createDomTextSearchHighlights(
  names: DomTextSearchHighlightNames
): DomTextSearchHighlights {
  const matchesByInstance = new Map<DomTextSearchInstance, readonly Range[]>()
  const activeByInstance = new Map<DomTextSearchInstance, Range>()
  const paintMatches = (api: HighlightApi): void =>
    paintUnion(api, names.match, flatten(matchesByInstance.values()))
  const paintActive = (api: HighlightApi): void =>
    paintUnion(api, names.active, activeByInstance.values())
  return {
    setMatches: (instance, ranges) => {
      matchesByInstance.set(instance, ranges)
      activeByInstance.delete(instance)
      const api = getHighlightApi()
      if (api) {
        paintMatches(api)
        paintActive(api)
      }
    },
    setActive: (instance, range) => {
      if (range) {
        activeByInstance.set(instance, range)
      } else {
        activeByInstance.delete(instance)
      }
      // Only the active range changed — don't rebuild the (potentially 100k-range)
      // match highlight on every Next/Prev navigation.
      const api = getHighlightApi()
      if (api) {
        paintActive(api)
      }
    },
    clear: (instance) => {
      matchesByInstance.delete(instance)
      activeByInstance.delete(instance)
      const api = getHighlightApi()
      if (api) {
        paintMatches(api)
        paintActive(api)
      }
    }
  }
}

export type DomTextSearchScope = {
  /** Text under an element this rejects is never searched. */
  rejectElement?: (element: HTMLElement) => boolean
  /** Selector for elements whose text matches as one string (e.g. highlighted code split into spans). */
  joinedTextSelector?: string
  /** The previous search's ranges, moved instead of allocated: every live Range slows the
   *  document's own text writes until it is collected, which a per-frame search outpaces. */
  reuse?: Range[]
}

function appendTextSearchRanges(
  nodes: Text[],
  query: string,
  ranges: Range[],
  reuse: Range[] | undefined
): void {
  const text = nodes.map((node) => node.data).join('')
  if (!text.trim()) {
    return
  }
  let nodeIndex = 0
  let offset = 0
  for (const { start, end } of findTextMatchRanges(text, query)) {
    while (nodeIndex < nodes.length - 1 && offset + nodes[nodeIndex].length <= start) {
      offset += nodes[nodeIndex++].length
    }
    const range = reuse?.pop() ?? document.createRange()
    range.setStart(nodes[nodeIndex], start - offset)
    while (nodeIndex < nodes.length - 1 && offset + nodes[nodeIndex].length < end) {
      offset += nodes[nodeIndex++].length
    }
    range.setEnd(nodes[nodeIndex], end - offset)
    ranges.push(range)
  }
}

/** Case-insensitive matches of `query` in the text under `root`, in document order. */
export function findDomTextSearchRanges(
  root: HTMLElement,
  query: string,
  scope: DomTextSearchScope = {}
): Range[] {
  const ranges: Range[] = []
  if (!query || isTextSearchQueryTooLarge(query)) {
    return ranges
  }
  const { rejectElement, joinedTextSelector, reuse } = scope
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!(parent instanceof HTMLElement) || rejectElement?.(parent)) {
        return NodeFilter.FILTER_REJECT
      }
      if (
        !node.textContent?.trim() &&
        !(joinedTextSelector && parent.closest(joinedTextSelector))
      ) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })

  let currentNode = walker.nextNode()
  while (currentNode) {
    if (!(currentNode instanceof Text)) {
      currentNode = walker.nextNode()
      continue
    }
    let joined = joinedTextSelector ? currentNode.parentElement?.closest(joinedTextSelector) : null
    while (joined && joinedTextSelector) {
      const outer = joined.parentElement?.closest(joinedTextSelector)
      if (!outer || !root.contains(outer)) {
        break
      }
      joined = outer
    }
    const nodes = [currentNode]
    let next = walker.nextNode()
    while (joined && next instanceof Text && joined.contains(next)) {
      nodes.push(next)
      next = walker.nextNode()
    }
    appendTextSearchRanges(nodes, query, ranges, reuse)
    currentNode = next
  }
  return ranges
}
