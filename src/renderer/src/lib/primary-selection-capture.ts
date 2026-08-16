import { PRIMARY_SELECTION_MAX_LENGTH } from './primary-selection'
import { isElement, isHTMLInputElement, isHTMLTextAreaElement } from './cross-realm-dom-predicates'

const TEXT_INPUT_TYPES = new Set(['', 'email', 'password', 'search', 'tel', 'text', 'url'])

function isTextInputElement(element: Element): element is HTMLInputElement {
  return isHTMLInputElement(element) && TEXT_INPUT_TYPES.has(element.type)
}

export function isPrimarySelectionTextControl(
  element: Element
): element is HTMLInputElement | HTMLTextAreaElement {
  return isTextInputElement(element) || isHTMLTextAreaElement(element)
}

function readTextControlSelection(element: HTMLInputElement | HTMLTextAreaElement): string | null {
  if (isHTMLInputElement(element) && element.type === 'password') {
    return null
  }

  try {
    const start = element.selectionStart
    const end = element.selectionEnd
    if (start === null || end === null || start === end) {
      return null
    }
    if (Math.abs(end - start) > PRIMARY_SELECTION_MAX_LENGTH) {
      return null
    }
    return element.value.slice(Math.min(start, end), Math.max(start, end))
  } catch {
    return null
  }
}

function getRangeTextLengthUpTo(range: Range, maxLength: number): number {
  let length = 0
  const root = range.commonAncestorContainer
  const ownerDocument = root.ownerDocument ?? document

  const addTextNode = (node: Text): boolean => {
    if (!range.intersectsNode(node)) {
      return false
    }
    let start = 0
    let end = node.data.length
    if (node === range.startContainer) {
      start = range.startOffset
    }
    if (node === range.endContainer) {
      end = range.endOffset
    }
    length += Math.max(0, end - start)
    return length > maxLength
  }

  if (root.nodeType === 3) {
    addTextNode(root as Text)
    return length
  }

  const showText = ownerDocument.defaultView?.NodeFilter.SHOW_TEXT ?? 4
  const walker = ownerDocument.createTreeWalker(root, showText)
  let node = walker.nextNode()
  while (node) {
    if (addTextNode(node as Text)) {
      return length
    }
    node = walker.nextNode()
  }
  return length
}

function selectionTextLengthExceeds(selection: Selection, maxLength: number): boolean {
  let length = 0
  for (let index = 0; index < selection.rangeCount; index += 1) {
    length += getRangeTextLengthUpTo(selection.getRangeAt(index), maxLength - length)
    if (length > maxLength) {
      return true
    }
  }
  return false
}

function readDocumentSelection(sourceDocument: Document): string | null {
  const selection = sourceDocument.getSelection()
  if (!selection || selection.isCollapsed) {
    return null
  }
  if (selectionTextLengthExceeds(selection, PRIMARY_SELECTION_MAX_LENGTH)) {
    return null
  }
  const text = selection.toString()
  return text.length > 0 ? text : null
}

export function readCurrentPrimarySelectionText(
  sourceDocument: Document = document
): string | null {
  const activeElement = sourceDocument.activeElement
  if (isElement(activeElement)) {
    const textControl = activeElement.closest('input, textarea')
    if (textControl && isPrimarySelectionTextControl(textControl)) {
      const text = readTextControlSelection(textControl)
      if (text) {
        return text
      }
    }
  }

  return readDocumentSelection(sourceDocument)
}
