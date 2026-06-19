import { isPrimarySelectionTextControl } from './primary-selection-capture'

export type EditablePrimarySelectionPasteTarget =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLElement

function dispatchInputEvent(target: Element, text: string): void {
  const event =
    typeof InputEvent === 'function'
      ? new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          data: text,
          inputType: 'insertFromPaste'
        })
      : new Event('input', { bubbles: true, cancelable: false })
  target.dispatchEvent(event)
}

function pasteIntoTextControl(
  target: HTMLInputElement | HTMLTextAreaElement,
  text: string
): boolean {
  if (target.disabled || target.readOnly) {
    return false
  }
  try {
    target.focus()
    const start = target.selectionStart ?? target.value.length
    const end = target.selectionEnd ?? start
    target.setRangeText(text, Math.min(start, end), Math.max(start, end), 'end')
    dispatchInputEvent(target, text)
    return true
  } catch {
    return false
  }
}

type CaretRangeDocument = Document & {
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

function setContentEditableCaretFromPoint(
  target: HTMLElement,
  point: { clientX: number; clientY: number }
): void {
  const ownerDocument = target.ownerDocument
  const selection = ownerDocument.getSelection()
  if (!selection) {
    return
  }

  const caretPosition = ownerDocument.caretPositionFromPoint?.(point.clientX, point.clientY)
  const range = caretPosition
    ? ownerDocument.createRange()
    : (ownerDocument as CaretRangeDocument).caretRangeFromPoint?.(point.clientX, point.clientY)

  if (caretPosition && range) {
    range.setStart(caretPosition.offsetNode, caretPosition.offset)
    range.collapse(true)
  }

  if (!range || !target.contains(range.startContainer)) {
    return
  }

  selection.removeAllRanges()
  selection.addRange(range)
}

function insertTextIntoContentEditable(target: HTMLElement, text: string): boolean {
  const ownerDocument = target.ownerDocument
  if (
    ownerDocument.queryCommandSupported?.('insertText') &&
    ownerDocument.execCommand('insertText', false, text)
  ) {
    return true
  }

  const selection = ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return false
  }

  const range = selection.getRangeAt(0)
  range.deleteContents()
  const textNode = ownerDocument.createTextNode(text)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  dispatchInputEvent(target, text)
  return true
}

function pasteIntoContentEditable(
  target: HTMLElement,
  text: string,
  point: { clientX: number; clientY: number }
): boolean {
  target.focus()
  setContentEditableCaretFromPoint(target, point)
  return insertTextIntoContentEditable(target, text)
}

export function findEditablePrimarySelectionPasteTarget(
  target: EventTarget | null
): EditablePrimarySelectionPasteTarget | null {
  if (!(target instanceof Element)) {
    return null
  }
  if (target.closest('.xterm-helper-textarea')) {
    return null
  }

  const textControl = target.closest('input, textarea')
  if (textControl && isPrimarySelectionTextControl(textControl)) {
    if (textControl.disabled || textControl.readOnly) {
      return null
    }
    return textControl
  }

  let element: HTMLElement | null = target instanceof HTMLElement ? target : target.parentElement
  while (element) {
    if (element.getAttribute('contenteditable') === 'false') {
      return null
    }
    if (element.isContentEditable) {
      return element
    }
    element = element.parentElement
  }

  return null
}

export function pastePrimarySelectionTextIntoTarget(
  target: EditablePrimarySelectionPasteTarget,
  text: string,
  point: { clientX: number; clientY: number }
): boolean {
  if (isPrimarySelectionTextControl(target)) {
    return pasteIntoTextControl(target, text)
  }
  return pasteIntoContentEditable(target, text, point)
}
