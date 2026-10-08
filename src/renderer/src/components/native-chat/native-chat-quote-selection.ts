/** Marks the prose of an agent reply; only a selection inside one of these can be quoted. */
export const NATIVE_CHAT_QUOTE_SOURCE_PROPS = { 'data-native-chat-quote-source': '' } as const

const QUOTE_SOURCE_SELECTOR = '[data-native-chat-quote-source]'

/** The selection when all of it sits inside one agent reply of this chat, else null. */
export function readNativeChatQuotableSelection(
  root: HTMLElement
): { text: string; range: Range } | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) {
    return null
  }
  const range = selection.getRangeAt(0)
  if (!root.contains(range.commonAncestorContainer)) {
    return null
  }
  const edges = selectedTextEdges(range)
  const source = edges?.first.parentElement?.closest(QUOTE_SOURCE_SELECTOR)
  const text = selection.toString().trim()
  if (!edges || !source || !source.contains(edges.last) || text === '') {
    return null
  }
  return { text, range }
}

// Why: a triple-click ends its range at the start of the next block, often outside the reply, so
// the reply is judged by the text actually selected and not by the range's endpoints.
function selectedTextEdges(range: Range): { first: Text; last: Text } | null {
  const container = range.commonAncestorContainer
  if (container instanceof Text) {
    return { first: container, last: container }
  }
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const covered: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text) || !range.intersectsNode(node)) {
      continue
    }
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    if (start < end) {
      covered.push(node)
    }
  }
  const first = covered.find(isSelectableText)
  const last = covered.findLast(isSelectableText)
  return first && last ? { first, last } : null
}

// Why: text that cannot be selected (a reply's timestamp) is in the range but not in the selection.
function isSelectableText(node: Text): boolean {
  return node.parentElement !== null && getComputedStyle(node.parentElement).userSelect !== 'none'
}

/** The text as a markdown blockquote, then the blank line that ends it so a reply can follow. */
export function formatNativeChatQuote(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  return `${lines.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')}\n\n`
}
