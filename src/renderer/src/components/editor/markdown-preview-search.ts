import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import { findTextMatchRanges, isMarkdownPreviewSearchQueryTooLarge } from './markdown-text-matches'
export {
  findTextMatchRanges,
  isMarkdownPreviewSearchQueryTooLarge,
  MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES,
  type TextMatchOptions
} from './markdown-text-matches'

export function isMarkdownPreviewFindShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('editor.find', event, platform, keybindings)
}

export function isMarkdownPreviewReplaceShortcut(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  return keybindingMatchesAction('editor.replace', event, platform, keybindings)
}

// Why: react-markdown owns the preview DOM. Injecting <mark> by splitting its
// text nodes (and normalize()-merging them on clear) left react holding stale
// child pointers, so the next streamed-content commit threw NotFoundError
// ("insertBefore ... not a child of this node"; crash 237acef1). Paint matches
// with the CSS Custom Highlight API instead — it highlights Ranges without
// mutating the DOM react manages. The static names below must match the
// ::highlight() selectors in markdown-preview.css.
const SEARCH_HIGHLIGHT_NAME = 'markdown-preview-search-match'
const ACTIVE_SEARCH_HIGHLIGHT_NAME = 'markdown-preview-search-active-match'

type HighlightLike = { add(range: Range): void }
type HighlightRegistryLike = {
  set(name: string, highlight: HighlightLike): void
  delete(name: string): void
}

// Accessed via globalThis so the code degrades to a no-op where the API is
// absent (older Chromium, jsdom/happy-dom in tests) — match counting and
// navigation still work off the returned Ranges; only the paint is skipped.
function getHighlightApi(): {
  registry: HighlightRegistryLike
  create: (ranges: readonly Range[]) => HighlightLike
} | null {
  const scope = globalThis as {
    CSS?: { highlights?: HighlightRegistryLike }
    Highlight?: new () => HighlightLike
  }
  const registry = scope.CSS?.highlights
  const HighlightCtor = scope.Highlight
  if (!registry || typeof HighlightCtor !== 'function') {
    return null
  }
  return {
    registry,
    // Why: build with .add() rather than new Highlight(...ranges). A big doc +
    // short query yields 100k+ ranges, and spreading that many constructor
    // args overflows V8's argument stack (RangeError) — the same large-content
    // regime as the bug this file fixes.
    create: (ranges) => {
      const highlight = new HighlightCtor()
      for (const range of ranges) {
        highlight.add(range)
      }
      return highlight
    }
  }
}

// Why: CSS.highlights is a document-global registry keyed by a static name, but
// several MarkdownPreview instances can be open at once (split panes, floating
// window). Track each instance's ranges by its own token and paint the UNION,
// so a second preview's Find does not clobber the first's highlights. Ranges
// live in each instance's own subtree, so the union paints every pane correctly.
declare const markdownPreviewSearchInstanceBrand: unique symbol

/** Per-preview identity for the highlight maps; only compared by reference. */
export type MarkdownPreviewSearchInstance = {
  readonly [markdownPreviewSearchInstanceBrand]?: never
}

const searchRangesByInstance = new Map<MarkdownPreviewSearchInstance, readonly Range[]>()
const activeRangeByInstance = new Map<MarkdownPreviewSearchInstance, Range>()

// Avoid array spread when collecting union ranges — a large doc can produce
// 100k+ ranges and create()/registry writes must not build variadic arg lists.
function paintMatchHighlight(api: NonNullable<ReturnType<typeof getHighlightApi>>): void {
  const matchRanges: Range[] = []
  for (const ranges of searchRangesByInstance.values()) {
    for (const range of ranges) {
      matchRanges.push(range)
    }
  }
  if (matchRanges.length > 0) {
    api.registry.set(SEARCH_HIGHLIGHT_NAME, api.create(matchRanges))
  } else {
    api.registry.delete(SEARCH_HIGHLIGHT_NAME)
  }
}

function paintActiveHighlight(api: NonNullable<ReturnType<typeof getHighlightApi>>): void {
  const activeRanges: Range[] = []
  for (const range of activeRangeByInstance.values()) {
    activeRanges.push(range)
  }
  if (activeRanges.length > 0) {
    api.registry.set(ACTIVE_SEARCH_HIGHLIGHT_NAME, api.create(activeRanges))
  } else {
    api.registry.delete(ACTIVE_SEARCH_HIGHLIGHT_NAME)
  }
}

export function clearMarkdownPreviewSearchHighlights(
  instanceId: MarkdownPreviewSearchInstance
): void {
  searchRangesByInstance.delete(instanceId)
  activeRangeByInstance.delete(instanceId)
  const api = getHighlightApi()
  if (api) {
    paintMatchHighlight(api)
    paintActiveHighlight(api)
  }
}

function appendTextSearchRanges(nodes: Text[], query: string, ranges: Range[]): void {
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
    const range = document.createRange()
    range.setStart(nodes[nodeIndex], start - offset)
    while (nodeIndex < nodes.length - 1 && offset + nodes[nodeIndex].length < end) {
      offset += nodes[nodeIndex++].length
    }
    range.setEnd(nodes[nodeIndex], end - offset)
    ranges.push(range)
  }
}

export function applyMarkdownPreviewSearchHighlights(
  instanceId: MarkdownPreviewSearchInstance,
  root: HTMLElement,
  query: string,
  options: { documentOnly?: boolean } = {}
): Range[] {
  const ranges: Range[] = []

  if (query && !isMarkdownPreviewSearchQueryTooLarge(query)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node.parentElement instanceof HTMLElement)) {
          return NodeFilter.FILTER_REJECT
        }
        if (
          options.documentOnly &&
          node.parentElement.closest(
            '.markdown-annotation-controls,[data-orca-export-hide],.code-block-copy-btn,.mermaid-block'
          )
        ) {
          return NodeFilter.FILTER_REJECT
        }
        if (
          !node.textContent?.trim() &&
          !(options.documentOnly && node.parentElement.closest('code'))
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
      let code = options.documentOnly ? currentNode.parentElement?.closest('code') : null
      while (code) {
        const parentCode = code.parentElement?.closest('code')
        if (!parentCode || !root.contains(parentCode)) {
          break
        }
        code = parentCode
      }
      const nodes = [currentNode]
      let next = walker.nextNode()
      while (code && next instanceof Text && code.contains(next)) {
        nodes.push(next)
        next = walker.nextNode()
      }
      appendTextSearchRanges(nodes, query, ranges)
      currentNode = next
    }
  }

  searchRangesByInstance.set(instanceId, ranges)
  activeRangeByInstance.delete(instanceId)
  const api = getHighlightApi()
  if (api) {
    paintMatchHighlight(api)
    paintActiveHighlight(api)
  }

  return ranges
}

export function setActiveMarkdownPreviewSearchMatch(
  instanceId: MarkdownPreviewSearchInstance,
  matches: readonly Range[],
  activeIndex: number,
  options: { scrollIntoView?: boolean } = {}
): void {
  const active = activeIndex >= 0 ? matches[activeIndex] : undefined

  if (active) {
    activeRangeByInstance.set(instanceId, active)
  } else {
    activeRangeByInstance.delete(instanceId)
  }

  const api = getHighlightApi()
  if (api) {
    // Only the active range changed — don't rebuild the (potentially 100k-range)
    // match highlight on every Next/Prev navigation.
    paintActiveHighlight(api)
  }

  if (active && options.scrollIntoView !== false) {
    // The Range's start container is a Text node; scroll its element into view.
    active.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }
}
