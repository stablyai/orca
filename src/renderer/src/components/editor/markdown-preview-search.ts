export function isMarkdownPreviewFindShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean
): boolean {
  const mod = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  return mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f'
}

export function findTextMatchRanges(text: string, query: string): { start: number; end: number }[] {
  if (!query) {
    return []
  }

  const normalizedText = text.toLocaleLowerCase()
  const normalizedQuery = query.toLocaleLowerCase()
  const matches: { start: number; end: number }[] = []
  let searchStart = 0

  while (searchStart <= normalizedText.length - normalizedQuery.length) {
    const matchStart = normalizedText.indexOf(normalizedQuery, searchStart)
    if (matchStart === -1) {
      break
    }

    matches.push({
      start: matchStart,
      end: matchStart + query.length
    })
    searchStart = matchStart + query.length
  }

  return matches
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

  if (!query) {
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
