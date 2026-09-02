import { keybindingMatchesAction, type KeybindingOverrides } from '../../../../shared/keybindings'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'

export const MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES = 2 * 1024

export function isMarkdownPreviewSearchQueryTooLarge(
  query: string,
  maxBytes = MARKDOWN_PREVIEW_SEARCH_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

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

export type TextMatchOptions = {
  matchCase?: boolean
  wholeWord?: boolean
}

export function findTextMatchRanges(
  text: string,
  query: string,
  options: TextMatchOptions = {}
): { start: number; end: number }[] {
  if (!query) {
    return []
  }
  if (isMarkdownPreviewSearchQueryTooLarge(query)) {
    return []
  }

  const ranges = options.matchCase
    ? findCaseSensitiveMatchRanges(text, query)
    : findCaseInsensitiveMatchRanges(text, query)

  if (!options.wholeWord) {
    return ranges
  }
  return ranges.filter((range) => isWholeWordMatch(text, range.start, range.end))
}

function findCaseSensitiveMatchRanges(
  text: string,
  query: string
): { start: number; end: number }[] {
  const matches: { start: number; end: number }[] = []
  let searchStart = 0

  while (searchStart <= text.length - query.length) {
    const matchStart = text.indexOf(query, searchStart)
    if (matchStart === -1) {
      break
    }
    matches.push({ start: matchStart, end: matchStart + query.length })
    searchStart = matchStart + query.length
  }

  return matches
}

function findCaseInsensitiveMatchRanges(
  text: string,
  query: string
): { start: number; end: number }[] {
  const normalizedText = buildLocaleLowercaseIndex(text)
  const normalizedQuery = query.toLocaleLowerCase()
  const matches: { start: number; end: number }[] = []
  let searchStart = 0

  while (searchStart <= normalizedText.text.length - normalizedQuery.length) {
    const matchStart = normalizedText.text.indexOf(normalizedQuery, searchStart)
    if (matchStart === -1) {
      break
    }

    const matchEnd = matchStart + normalizedQuery.length
    matches.push({
      start: normalizedText.originalStartByNormalizedOffset[matchStart] ?? text.length,
      end: normalizedText.originalEndByNormalizedOffset[matchEnd - 1] ?? text.length
    })
    // Why: advance by at least 1 to guarantee forward progress even if a
    // future locale edge-case produces a zero-length normalizedQuery.
    searchStart = matchEnd + (normalizedQuery.length === 0 ? 1 : 0)
  }

  return matches
}

// Why: whole-word matching treats Unicode letters, digits, and underscore as
// word characters so a match only counts when both edges sit on a word boundary,
// mirroring the editor's "whole word" find toggle.
const WORD_CHARACTER = /[\p{L}\p{N}_]/u

function isWordCharacter(char: string | undefined): boolean {
  return char !== undefined && WORD_CHARACTER.test(char)
}

function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) {
    return undefined
  }

  const previousCodeUnit = text.charCodeAt(index - 1)
  if (
    previousCodeUnit >= 0xdc00 &&
    previousCodeUnit <= 0xdfff &&
    index > 1 &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff
  ) {
    return text.slice(index - 2, index)
  }

  return text[index - 1]
}

function codePointAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index)
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint)
}

function isWholeWordMatch(text: string, start: number, end: number): boolean {
  const before = codePointBefore(text, start)
  const after = codePointAt(text, end)
  return !isWordCharacter(before) && !isWordCharacter(after)
}

function buildLocaleLowercaseIndex(text: string): {
  text: string
  originalStartByNormalizedOffset: number[]
  originalEndByNormalizedOffset: number[]
} {
  let normalized = ''
  const originalStartByNormalizedOffset: number[] = []
  const originalEndByNormalizedOffset: number[] = []
  let originalOffset = 0

  for (const char of text) {
    const normalizedChar = char.toLocaleLowerCase()
    const originalEnd = originalOffset + char.length
    // Why: locale lowercasing can expand one original character into multiple
    // UTF-16 code units (for example `İ` -> `i\u0307`). Search matches happen
    // in normalized text but DOM slicing needs original offsets.
    for (let i = 0; i < normalizedChar.length; i += 1) {
      originalStartByNormalizedOffset.push(originalOffset)
      originalEndByNormalizedOffset.push(originalEnd)
    }
    normalized += normalizedChar
    originalOffset = originalEnd
  }

  return { text: normalized, originalStartByNormalizedOffset, originalEndByNormalizedOffset }
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
const searchRangesByInstance = new Map<object, readonly Range[]>()
const activeRangeByInstance = new Map<object, Range>()

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

export function clearMarkdownPreviewSearchHighlights(instanceId: object): void {
  searchRangesByInstance.delete(instanceId)
  activeRangeByInstance.delete(instanceId)
  const api = getHighlightApi()
  if (api) {
    paintMatchHighlight(api)
    paintActiveHighlight(api)
  }
}

export function applyMarkdownPreviewSearchHighlights(
  instanceId: object,
  root: HTMLElement,
  query: string
): Range[] {
  const ranges: Range[] = []

  if (query && !isMarkdownPreviewSearchQueryTooLarge(query)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!(node.parentElement instanceof HTMLElement)) {
          return NodeFilter.FILTER_REJECT
        }
        if (!node.textContent?.trim()) {
          return NodeFilter.FILTER_REJECT
        }
        return NodeFilter.FILTER_ACCEPT
      }
    })

    let currentNode = walker.nextNode()
    while (currentNode) {
      if (currentNode instanceof Text) {
        const text = currentNode.textContent ?? ''
        // findTextMatchRanges returns offsets into the original text, so they
        // map straight onto this Text node without any DOM rewrite.
        for (const { start, end } of findTextMatchRanges(text, query)) {
          const range = document.createRange()
          range.setStart(currentNode, start)
          range.setEnd(currentNode, end)
          ranges.push(range)
        }
      }
      currentNode = walker.nextNode()
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
  instanceId: object,
  matches: readonly Range[],
  activeIndex: number
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

  if (active) {
    // The Range's start container is a Text node; scroll its element into view.
    active.startContainer.parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }
}
