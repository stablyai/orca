import { readNativeChatQuotableSelection } from './native-chat-quote-selection'

export type NativeChatAnnotationAnchor = {
  quote: string
  messageId: string
  startOffset: number
}

const SOURCE_SELECTOR = '[data-native-chat-quote-source]'
const MESSAGE_SELECTOR = '[data-native-chat-annotation-message-id], [data-native-chat-message-id]'

function messageIdForAnnotation(message: Element): string | null {
  return (
    message.getAttribute('data-native-chat-annotation-message-id') ??
    message.getAttribute('data-native-chat-message-id')
  )
}

function messageSources(root: HTMLElement, message: Element): Element[] {
  const sources = Array.from(message.querySelectorAll(SOURCE_SELECTOR))
  if (message.matches(SOURCE_SELECTOR)) {
    sources.unshift(message)
  }
  return sources.filter(
    (source) => root.contains(source) && source.closest(MESSAGE_SELECTOR) === message
  )
}

function selectedTextNodes(range: Range): Text[] {
  const container = range.commonAncestorContainer
  if (container instanceof Text) {
    return isSelectableText(container) ? [container] : []
  }
  const walker = container.ownerDocument?.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker?.nextNode(); node; node = walker?.nextNode()) {
    if (!(node instanceof Text) || !range.intersectsNode(node)) {
      continue
    }
    const start = node === range.startContainer ? range.startOffset : 0
    const end = node === range.endContainer ? range.endOffset : node.length
    if (end > start && isSelectableText(node)) {
      nodes.push(node)
    }
  }
  return nodes
}

function isSelectableText(node: Text): boolean {
  const element = node.parentElement
  return (
    element !== null &&
    node.ownerDocument.defaultView?.getComputedStyle(element).userSelect !== 'none'
  )
}

export function readNativeChatAnnotationAnchor(
  root: HTMLElement,
  range?: Range
): NativeChatAnnotationAnchor | null {
  const selected = range ?? readNativeChatQuotableSelection(root)?.range
  if (!selected || selected.collapsed || !root.contains(selected.commonAncestorContainer)) {
    return null
  }
  const nodes = selectedTextNodes(selected)
  const first = nodes[0]
  const last = nodes.at(-1)
  const source = first?.parentElement?.closest(SOURCE_SELECTOR)
  const message = source?.closest(MESSAGE_SELECTOR)
  const messageId = message ? messageIdForAnnotation(message) : null
  if (
    !first ||
    !last ||
    !source ||
    !message ||
    !messageId ||
    !root.contains(message) ||
    nodes.some(
      (node) =>
        node.parentElement?.closest(SOURCE_SELECTOR) !== source ||
        node.parentElement?.closest(MESSAGE_SELECTOR) !== message
    )
  ) {
    return null
  }
  // A triple-click can end past the reply, inside a timestamp that cannot be selected.
  const bounded = selected.cloneRange()
  bounded.setStart(first, first === selected.startContainer ? selected.startOffset : 0)
  bounded.setEnd(last, last === selected.endContainer ? selected.endOffset : last.length)
  const text = bounded.toString()
  const quote = text.trim()
  if (!quote) {
    return null
  }
  const prefix = root.ownerDocument.createRange()
  prefix.selectNodeContents(source)
  prefix.setEnd(first, first === selected.startContainer ? selected.startOffset : 0)
  let startOffset = prefix.toString().length + text.length - text.trimStart().length
  for (const previous of messageSources(root, message)) {
    if (previous === source) {
      break
    }
    startOffset += previous.textContent?.length ?? 0
  }
  return { quote, messageId, startOffset }
}

function rangeInSource(source: Element, offset: number, length: number): Range | null {
  const document = source.ownerDocument
  const walker = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let position = 0
  let started = false
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) {
      continue
    }
    const end = position + node.length
    if (!started && offset < end) {
      range.setStart(node, offset - position)
      started = true
    }
    if (started && offset + length <= end) {
      range.setEnd(node, offset + length - position)
      return range
    }
    position = end
  }
  return null
}

export function resolveNativeChatAnnotationRange(
  root: HTMLElement,
  anchor: NativeChatAnnotationAnchor
): Range | null {
  if (!anchor.quote || !Number.isSafeInteger(anchor.startOffset) || anchor.startOffset < 0) {
    return null
  }
  const messages = Array.from(root.querySelectorAll(MESSAGE_SELECTOR))
  if (root.matches(MESSAGE_SELECTOR)) {
    messages.unshift(root)
  }
  for (const message of messages) {
    if (messageIdForAnnotation(message) !== anchor.messageId) {
      continue
    }
    let offset = anchor.startOffset
    for (const source of messageSources(root, message)) {
      const text = source.textContent ?? ''
      if (offset < text.length) {
        // A changed reply must not move a note to another copy of the same words.
        return text.slice(offset, offset + anchor.quote.length) === anchor.quote
          ? rangeInSource(source, offset, anchor.quote.length)
          : null
      }
      offset -= text.length
    }
  }
  return null
}
