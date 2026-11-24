import { PRIMARY_SELECTION_MAX_LENGTH } from './primary-selection'

const TEXT_INPUT_TYPES = new Set(['', 'email', 'password', 'search', 'tel', 'text', 'url'])

function isTextInputElement(element: Element): element is HTMLInputElement {
  return element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)
}

export function isPrimarySelectionTextControl(
  element: Element
): element is HTMLInputElement | HTMLTextAreaElement {
  return isTextInputElement(element) || element instanceof HTMLTextAreaElement
}

function readTextControlSelection(element: HTMLInputElement | HTMLTextAreaElement): string | null {
  if (element instanceof HTMLInputElement && element.type === 'password') {
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

  if (root.nodeType === Node.TEXT_NODE) {
    addTextNode(root as Text)
    return length
  }

  const walker = ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
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

function readDocumentSelection(): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) {
    return null
  }
  if (selectionTextLengthExceeds(selection, PRIMARY_SELECTION_MAX_LENGTH)) {
    return null
  }
  const text = selection.toString()
  return text.length > 0 ? text : null
}

export function readCurrentPrimarySelectionText(): string | null {
  const activeElement = document.activeElement
  if (activeElement instanceof Element) {
    const textControl = activeElement.closest('input, textarea')
    if (textControl && isPrimarySelectionTextControl(textControl)) {
      const text = readTextControlSelection(textControl)
      if (text) {
        return text
      }
    }
  }

  return readDocumentSelection()
}
