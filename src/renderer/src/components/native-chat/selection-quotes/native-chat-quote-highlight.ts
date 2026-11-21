import { textHash, type QuotePlace, type QuoteSource } from './native-chat-quote-sources'

const HIGHLIGHT = 'native-chat-quote-jump'
const QUOTE_HIGHLIGHT_MS = 1500

function textNodes(root: Node): Text[] {
  const nodes: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node instanceof Text) {
      nodes.push(node)
    }
  }
  return nodes
}

/** The range from `start` to `end` in the joined text of `nodes`. */
function textRange(nodes: Text[], start: number, end: number): Range | null {
  const range = document.createRange()
  let started = false
  for (const node of nodes) {
    // `<`: a range that starts where a text node ends starts in the next one.
    if (!started && start < node.data.length) {
      range.setStart(node, start)
      started = true
    }
    if (started && end <= node.data.length) {
      range.setEnd(node, end)
      return range
    }
    start -= node.data.length
    end -= node.data.length
  }
  return null
}

/** Where `range` is in the text of `source`: the selection that "Add to chat" takes. */
export function quotePlace(source: Element, range: Range): QuotePlace {
  const clamped = range.cloneRange()
  if (!source.contains(clamped.startContainer)) {
    clamped.setStart(source, 0)
  }
  if (!source.contains(clamped.endContainer)) {
    clamped.setEnd(source, source.childNodes.length)
  }
  const before = document.createRange()
  before.setStart(source, 0)
  before.setEnd(clamped.startContainer, clamped.startOffset)
  const text = clamped.toString()
  return { offset: before.toString().length, length: text.length, hash: textHash(text) }
}

/**
 * The message, its chat and the place a selection in `sourceElement` quotes, or null for a message
 * with no id.
 */
export function quoteSourceOf(sourceElement: Element, range: Range): QuoteSource | null {
  const messageId = sourceElement.getAttribute('data-native-chat-quote-source')
  const chat = sourceElement
    .closest('[data-native-chat-quote-chat]')
    ?.getAttribute('data-native-chat-quote-chat')
  return messageId
    ? { messageId, place: quotePlace(sourceElement, range), ...(chat ? { chat } : {}) }
    : null
}

/** The range at `place` in the text of `root`, while the text there is still the quoted text. */
export function placeRange(root: HTMLElement, place: QuotePlace): Range | null {
  const range = textRange(textNodes(root), place.offset, place.offset + place.length)
  return range && textHash(range.toString()) === place.hash ? range : null
}

const WORD_CHAR = /[\p{L}\p{N}_]/u

/**
 * The first range of `text` in `root`, for a reply drawn again since the quote. Whitespace in the
 * quote matches any whitespace or none: a selection has line breaks between blocks that the page
 * text does not have. A whole-word match comes first, so a quote does not match inside a longer
 * word. Without one, any match counts: scripts without spaces, Korean particles and blocks drawn
 * against the next block have no word edge at the quote.
 */
export function quotedTextRange(root: HTMLElement, text: string): Range | null {
  const words = text.trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return null
  }
  const body = words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*')
  const before = WORD_CHAR.test(text.trim()[0]) ? '(?<![\\p{L}\\p{N}_])' : ''
  const after = WORD_CHAR.test(text.trim().at(-1) ?? '') ? '(?![\\p{L}\\p{N}_])' : ''
  const nodes = textNodes(root)
  const page = nodes.map((node) => node.data).join('')
  const match =
    new RegExp(`${before}${body}${after}`, 'u').exec(page) ?? new RegExp(body, 'u').exec(page)
  if (!match) {
    return null
  }
  return textRange(nodes, match.index, match.index + match[0].length)
}

/**
 * Moves focus to the quote's source and highlights the quote there for a short time: at its saved
 * place, or where the text is found when the reply changed since.
 */
export function showQuotedText(source: HTMLElement, text: string, place: QuotePlace | null): void {
  const range = (place && placeRange(source, place)) ?? quotedTextRange(source, text)
  // Focus moves too, so the highlight is not the only signal.
  if (!source.hasAttribute('tabindex')) {
    source.tabIndex = -1
  }
  source.focus({ preventScroll: true })
  range?.startContainer.parentElement?.scrollIntoView({ block: 'center' })
  const highlights = globalThis.CSS?.highlights
  if (range && highlights && typeof Highlight !== 'undefined') {
    const highlight = new Highlight(range)
    highlights.set(HIGHLIGHT, highlight)
    // A later jump keeps its own highlight for its whole time.
    window.setTimeout(() => {
      if (highlights.get(HIGHLIGHT) === highlight) {
        highlights.delete(HIGHLIGHT)
      }
    }, QUOTE_HIGHLIGHT_MS)
  }
}
