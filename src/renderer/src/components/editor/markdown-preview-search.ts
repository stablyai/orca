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

export function findTextMatchRanges(text: string, query: string): { start: number; end: number }[] {
  if (!query) {
    return []
  }
  if (isMarkdownPreviewSearchQueryTooLarge(query)) {
    return []
  }

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
