import { markdownMathSelectionText } from '../../../markdown/markdown-math-selection'

/** Only agent-reply prose marked with this attribute may be quoted, in desktop and phone chat. */
export const NATIVE_CHAT_QUOTE_SOURCE_PROPS = { 'data-native-chat-quote-source': '' } as const
/** The same attribute as react-native-web's `dataSet`, for the phone's chat page. */
export const NATIVE_CHAT_QUOTE_SOURCE_DATASET = { nativeChatQuoteSource: '' } as const

const QUOTE_SOURCE_SELECTOR = '[data-native-chat-quote-source]'

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
  if (!edges || !source || !source.contains(edges.last)) {
    return null
  }
  const text = (markdownMathSelectionText(selection, root) ?? selection.toString()).trim()
  return text === '' ? null : { text, range }
}

// Triple-click ranges can end outside the reply; check selected text edges instead of range endpoints.
export function selectedTextEdges(range: Range): { first: Text; last: Text } | null {
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

export function formatNativeChatQuote(text: string): string {
  const lines = text.trim().split(/\r?\n/)
  return `${lines.map((line) => (line.trim() ? `> ${line}` : '>')).join('\n')}\n\n`
}

/** The quote after what the draft holds, as typing it would: nothing is replaced or deduplicated. */
export function appendNativeChatQuote(draft: string, quote: string): string {
  const kept = draft.trimEnd()
  return kept === '' ? quote : `${kept}\n\n${quote}`
}
