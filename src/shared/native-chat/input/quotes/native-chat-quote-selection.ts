import { markdownMathSelectionText } from '../../../markdown/markdown-math-selection'

/**
 * Only message prose marked with this attribute may be quoted, in desktop and phone chat.
 * On desktop its value is the message id, so a quote can find its source.
 */
export function nativeChatQuoteSourceProps(messageId: string): Record<string, string> {
  return { 'data-native-chat-quote-source': messageId }
}
/** The same attribute as react-native-web's `dataSet`, for the phone's chat page. */
export const NATIVE_CHAT_QUOTE_SOURCE_DATASET = { nativeChatQuoteSource: '' } as const

const QUOTE_SOURCE_SELECTOR = '[data-native-chat-quote-source]'

/**
 * Marks controls that can show a secret (the webhook card's revealed key). Their text never enters a
 * quote, copy-on-select, the context menu's copy or transcript find; their own Copy buttons stay.
 */
export const NATIVE_CHAT_SECRET_PROPS = {
  'data-native-chat-secret': '',
  'data-native-chat-find-skip': ''
} as const
const SECRET_SELECTOR = '[data-native-chat-secret]'

/** The selection's text as the transcript reads it, with any secret-bearing control left out. */
export function nativeChatSelectionText(selection: Selection, root: Element): string {
  const range = selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  const common = range?.commonAncestorContainer
  const commonElement = common instanceof Element ? common : (common?.parentElement ?? null)
  // Wholly inside one: a clone of the range wouldn't carry the marker to strip.
  if (commonElement?.closest(SECRET_SELECTOR)) {
    return ''
  }
  const secrets = range
    ? [...root.querySelectorAll(SECRET_SELECTOR)].filter((node) => range.intersectsNode(node))
    : []
  if (!range || secrets.length === 0) {
    return markdownMathSelectionText(selection, root) ?? selection.toString()
  }
  // A clone keeps the marker even when the selection starts or ends inside the control.
  const fragment = range.cloneContents()
  fragment.querySelectorAll(SECRET_SELECTOR).forEach((node) => node.remove())
  return fragment.textContent ?? ''
}

/** `sourceElement` is the message element that holds the selection. */
export function readNativeChatQuotableSelection(
  root: HTMLElement
): { text: string; range: Range; sourceElement: Element } | null {
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
  const text = nativeChatSelectionText(selection, root).trim()
  return text === '' ? null : { text, range, sourceElement: source }
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

/** The text of a quote that `formatNativeChatQuote` wrote, without its `>` marks. */
export function quotedText(quote: string): string {
  return quote
    .trim()
    .split('\n')
    .map((line) => line.replace(/^ {0,3}> ?/, ''))
    .join('\n')
}
