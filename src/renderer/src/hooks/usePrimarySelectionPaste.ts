import { useEffect } from 'react'
import { isLinuxUserAgent } from '@/components/terminal-pane/pane-helpers'
import {
  getPrimarySelectionText,
  setPrimarySelectionEnabled,
  setPrimarySelectionText
} from '@/lib/primary-selection'

type EditablePasteTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement

const TEXT_INPUT_TYPES = new Set(['', 'email', 'password', 'search', 'tel', 'text', 'url'])

export function resolvePrimarySelectionMiddleClickPaste(
  setting: boolean | undefined,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return setting ?? isLinuxUserAgent(userAgent)
}

function isTextInputElement(element: Element): element is HTMLInputElement {
  return element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)
}

function isTextControl(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
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
    return element.value.slice(Math.min(start, end), Math.max(start, end))
  } catch {
    return null
  }
}

function readDocumentSelection(): string | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) {
    return null
  }
  const text = selection.toString()
  return text.length > 0 ? text : null
}

function captureCurrentSelection(): void {
  const activeElement = document.activeElement
  if (activeElement instanceof Element) {
    const textControl = activeElement.closest('input, textarea')
    if (textControl && isTextControl(textControl)) {
      const text = readTextControlSelection(textControl)
      if (text) {
        setPrimarySelectionText(text)
        return
      }
    }
  }

  const text = readDocumentSelection()
  if (text) {
    setPrimarySelectionText(text)
  }
}

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

function findEditablePasteTarget(target: EventTarget | null): EditablePasteTarget | null {
  if (!(target instanceof Element)) {
    return null
  }
  if (target.closest('.xterm-helper-textarea')) {
    return null
  }

  const textControl = target.closest('input, textarea')
  if (textControl && isTextControl(textControl)) {
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

function pasteIntoEditableTarget(
  target: EditablePasteTarget,
  text: string,
  point: { clientX: number; clientY: number }
): boolean {
  if (isTextControl(target)) {
    return pasteIntoTextControl(target, text)
  }
  return pasteIntoContentEditable(target, text, point)
}

function suppressEvent(event: Event): void {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

export function usePrimarySelectionPaste(enabled: boolean): void {
  useEffect(() => {
    setPrimarySelectionEnabled(enabled)
    if (!enabled) {
      return
    }

    let captureTimer: number | null = null
    let pendingMiddleTarget: EditablePasteTarget | null = null
    let pendingMiddleUntil = 0

    const scheduleCapture = (): void => {
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
      captureTimer = window.setTimeout(() => {
        captureTimer = null
        captureCurrentSelection()
      }, 100)
    }

    const targetMatchesPending = (target: EventTarget | null): boolean => {
      if (!pendingMiddleTarget || !(target instanceof Node)) {
        return false
      }
      return target === pendingMiddleTarget || pendingMiddleTarget.contains(target)
    }

    const onMouseDown = (event: MouseEvent): void => {
      if (event.button !== 1) {
        return
      }
      const target = findEditablePasteTarget(event.target)
      if (!target) {
        return
      }
      pendingMiddleTarget = target
      pendingMiddleUntil = Date.now() + 750
    }

    const onBeforeInput = (event: InputEvent): void => {
      if (
        pendingMiddleTarget &&
        Date.now() <= pendingMiddleUntil &&
        targetMatchesPending(event.target) &&
        event.inputType === 'insertFromPaste'
      ) {
        suppressEvent(event)
      }
    }

    const onPaste = (event: ClipboardEvent): void => {
      if (
        pendingMiddleTarget &&
        Date.now() <= pendingMiddleUntil &&
        targetMatchesPending(event.target)
      ) {
        suppressEvent(event)
      }
    }

    const onMouseUp = (event: MouseEvent): void => {
      if (event.button !== 1 || !pendingMiddleTarget || Date.now() > pendingMiddleUntil) {
        pendingMiddleTarget = null
        return
      }

      const target = pendingMiddleTarget
      pendingMiddleTarget = null
      const text = getPrimarySelectionText()
      suppressEvent(event)
      if (!text) {
        return
      }

      pasteIntoEditableTarget(target, text, {
        clientX: event.clientX,
        clientY: event.clientY
      })
    }

    const onAuxClick = (event: MouseEvent): void => {
      if (event.button === 1 && findEditablePasteTarget(event.target)) {
        suppressEvent(event)
      }
    }

    document.addEventListener('selectionchange', scheduleCapture)
    document.addEventListener('mouseup', scheduleCapture, true)
    document.addEventListener('keyup', scheduleCapture, true)
    document.addEventListener('mousedown', onMouseDown, true)
    document.addEventListener('beforeinput', onBeforeInput, true)
    document.addEventListener('paste', onPaste, true)
    document.addEventListener('mouseup', onMouseUp, true)
    document.addEventListener('auxclick', onAuxClick, true)

    return () => {
      setPrimarySelectionEnabled(false)
      if (captureTimer !== null) {
        window.clearTimeout(captureTimer)
      }
      document.removeEventListener('selectionchange', scheduleCapture)
      document.removeEventListener('mouseup', scheduleCapture, true)
      document.removeEventListener('keyup', scheduleCapture, true)
      document.removeEventListener('mousedown', onMouseDown, true)
      document.removeEventListener('beforeinput', onBeforeInput, true)
      document.removeEventListener('paste', onPaste, true)
      document.removeEventListener('mouseup', onMouseUp, true)
      document.removeEventListener('auxclick', onAuxClick, true)
    }
  }, [enabled])
}
