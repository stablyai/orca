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

export function clearMarkdownPreviewSearchHighlights(root: HTMLElement): void {
  const highlights = root.querySelectorAll<HTMLElement>('[data-markdown-preview-search-match]')
  for (const highlight of highlights) {
    const textNode = document.createTextNode(highlight.textContent ?? '')
    highlight.replaceWith(textNode)
  }
  root.normalize()
}

export function applyMarkdownPreviewSearchHighlights(
  root: HTMLElement,
  query: string
): HTMLElement[] {
  clearMarkdownPreviewSearchHighlights(root)

  if (!query || isMarkdownPreviewSearchQueryTooLarge(query)) {
    return []
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!(node.parentElement instanceof HTMLElement)) {
        return NodeFilter.FILTER_REJECT
      }
      if (node.parentElement.closest('[data-markdown-preview-search-match]')) {
        return NodeFilter.FILTER_REJECT
      }
      if (!node.textContent?.trim()) {
        return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })

  const textNodes: Text[] = []
  let currentNode = walker.nextNode()
  while (currentNode) {
    if (currentNode instanceof Text) {
      textNodes.push(currentNode)
    }
    currentNode = walker.nextNode()
  }

  const matches: HTMLElement[] = []
  for (const textNode of textNodes) {
    const text = textNode.textContent ?? ''
    const ranges = findTextMatchRanges(text, query)
    if (ranges.length === 0) {
      continue
    }

    const fragment = document.createDocumentFragment()
    let cursor = 0
    for (const range of ranges) {
      if (range.start > cursor) {
        fragment.append(document.createTextNode(text.slice(cursor, range.start)))
      }

      const highlight = document.createElement('mark')
      highlight.dataset.markdownPreviewSearchMatch = 'true'
      highlight.className = 'markdown-preview-search-match'
      highlight.textContent = text.slice(range.start, range.end)
      fragment.append(highlight)
      matches.push(highlight)
      cursor = range.end
    }

    if (cursor < text.length) {
      fragment.append(document.createTextNode(text.slice(cursor)))
    }

    textNode.replaceWith(fragment)
  }

  return matches
}

export function setActiveMarkdownPreviewSearchMatch(
  matches: readonly HTMLElement[],
  activeIndex: number
): void {
  for (const [index, match] of matches.entries()) {
    const isActive = index === activeIndex
    match.toggleAttribute('data-active', isActive)
    if (isActive) {
      match.scrollIntoView({ block: 'center', inline: 'nearest' })
    }
  }
}
