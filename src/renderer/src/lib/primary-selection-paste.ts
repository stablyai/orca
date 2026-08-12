import { yieldToEventLoop } from '../../../shared/event-loop-yield'
import { getUtf8ChunkEndIndex } from '../../../shared/utf8-byte-limits'
import { isPrimarySelectionTextControl } from './primary-selection-capture'
import {
  TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES,
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES,
  measureTextControlPasteByteLength,
  measureTextControlPasteByteLengthWithYield,
  pasteTextIntoTextControl
} from './text-control-paste'

export type EditablePrimarySelectionPasteTarget =
  | HTMLInputElement
  | HTMLTextAreaElement
  | HTMLElement

type PrimarySelectionPasteOptions = {
  chunkMaxBytes?: number
  directMaxBytes?: number
  maxBytes?: number
  measureYieldAfterCodeUnits?: number
  yieldToEventLoop?: () => Promise<void>
  canContinue?: (target: EditablePrimarySelectionPasteTarget) => boolean
}

function dispatchInputEvent(target: Element, text: string | null): void {
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

function isContentEditablePasteTargetAvailable(
  target: HTMLElement,
  canContinue: PrimarySelectionPasteOptions['canContinue']
): boolean {
  return target.isConnected && target.isContentEditable && (canContinue?.(target) ?? true)
}

function getContentEditableInsertionRange(target: HTMLElement): Range | null {
  const selection = target.ownerDocument.getSelection()
  if (!selection || selection.rangeCount === 0) {
    return null
  }
  const range = selection.getRangeAt(0)
  if (!target.contains(range.startContainer) || !target.contains(range.endContainer)) {
    return null
  }
  return range
}

function insertContentEditableChunk(target: HTMLElement, range: Range, text: string): Range {
  range.deleteContents()
  const textNode = target.ownerDocument.createTextNode(text)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  const selection = target.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  return range
}

async function pasteLargeTextIntoContentEditable(
  target: HTMLElement,
  text: string,
  options: PrimarySelectionPasteOptions
): Promise<boolean> {
  const chunkMaxBytes = options.chunkMaxBytes ?? TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES
  let range = getContentEditableInsertionRange(target)
  if (!range) {
    return false
  }
  range.deleteContents()
  let textIndex = 0

  // Why: contenteditable primary-selection paste cannot rely on browser
  // execCommand for large payloads; chunked text nodes keep the renderer yielding.
  while (textIndex < text.length) {
    if (!isContentEditablePasteTargetAvailable(target, options.canContinue)) {
      if (textIndex > 0) {
        dispatchInputEvent(target, null)
      }
      return false
    }
    const nextIndex = getUtf8ChunkEndIndex(text, textIndex, chunkMaxBytes)
    range = insertContentEditableChunk(target, range, text.slice(textIndex, nextIndex))
    textIndex = nextIndex
    if (textIndex < text.length) {
      await (options.yieldToEventLoop ?? yieldToEventLoop)()
    }
  }

  dispatchInputEvent(target, null)
  return true
}

async function pasteIntoContentEditable(
  target: HTMLElement,
  text: string,
  point: { clientX: number; clientY: number },
  options: PrimarySelectionPasteOptions
): Promise<boolean> {
  const maxBytes = options.maxBytes ?? TEXT_CONTROL_PASTE_MAX_BYTES
  const directMaxBytes = options.directMaxBytes ?? TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
  const directByteLengthMeasurement = measureTextControlPasteByteLength(text, {
    stopAfterBytes: Math.min(directMaxBytes, maxBytes)
  })
  const { byteLength } = directByteLengthMeasurement
  if (byteLength === 0) {
    return false
  }
  if (maxBytes <= directMaxBytes && directByteLengthMeasurement.exceededLimit) {
    return false
  }
  const largeByteLengthMeasurement = directByteLengthMeasurement.exceededLimit
    ? await measureTextControlPasteByteLengthWithYield(text, {
        stopAfterBytes: maxBytes,
        yieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
        yieldToEventLoop: options.yieldToEventLoop
      })
    : directByteLengthMeasurement
  if (largeByteLengthMeasurement.exceededLimit) {
    return false
  }

  target.focus()
  setContentEditableCaretFromPoint(target, point)
  if (!isContentEditablePasteTargetAvailable(target, options.canContinue)) {
    return false
  }
  if (largeByteLengthMeasurement.byteLength <= directMaxBytes) {
    return insertTextIntoContentEditable(target, text)
  }
  return pasteLargeTextIntoContentEditable(target, text, options)
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

export async function pastePrimarySelectionTextIntoTarget(
  target: EditablePrimarySelectionPasteTarget,
  text: string,
  point: { clientX: number; clientY: number },
  options: PrimarySelectionPasteOptions = {}
): Promise<boolean> {
  if (isPrimarySelectionTextControl(target)) {
    const targetStillFocused = (candidate: HTMLInputElement | HTMLTextAreaElement): boolean =>
      candidate.ownerDocument.activeElement === candidate &&
      (options.canContinue?.(candidate) ?? true)
    const result = await pasteTextIntoTextControl(target, text, {
      source: 'primary-selection',
      directMaxBytes: options.directMaxBytes,
      chunkMaxBytes: options.chunkMaxBytes,
      maxBytes: options.maxBytes,
      measureYieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
      yieldToEventLoop: options.yieldToEventLoop,
      // Why: async middle-click paste can outlive focus ownership, especially
      // during chunked textarea insertion.
      canContinue: targetStillFocused
    })
    return result.status === 'pasted'
  }
  return pasteIntoContentEditable(target, text, point, {
    ...options,
    canContinue: (candidate) =>
      candidate.ownerDocument.activeElement === candidate &&
      (options.canContinue?.(candidate) ?? true)
  })
}
