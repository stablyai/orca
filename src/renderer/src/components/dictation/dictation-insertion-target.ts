import { yieldToEventLoop } from '../../../../shared/event-loop-yield'
import { getUtf8ChunkEndIndex } from '../../../../shared/utf8-byte-limits'
import {
  TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES,
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES,
  measureTextControlPasteByteLength,
  measureTextControlPasteByteLengthWithYield,
  pasteTextIntoTextControl
} from '@/lib/text-control-paste'
import { DICTATION_FOCUS_INPUT_EVENT } from './dictation-control-events'

export type DictationInsertionTarget =
  | { kind: 'terminal'; tabId: string; paneId: number }
  | { kind: 'text'; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'contentEditable'; element: HTMLElement }

export function captureInsertionTarget(): DictationInsertionTarget | null {
  const focused = readFocusedInsertionTarget()
  if (focused) {
    return focused
  }
  document.dispatchEvent(new Event(DICTATION_FOCUS_INPUT_EVENT))
  return readFocusedInsertionTarget()
}

function readFocusedInsertionTarget(): DictationInsertionTarget | null {
  const activeElement = document.activeElement

  if (!activeElement) {
    return null
  }

  if (activeElement.classList.contains('xterm-helper-textarea')) {
    const paneElement = activeElement.closest('.pane[data-pane-id]') as HTMLElement | null
    const tabElement = activeElement.closest('[data-terminal-tab-id]') as HTMLElement | null
    const paneId = Number(paneElement?.dataset.paneId)
    const tabId = tabElement?.dataset.terminalTabId
    if (tabId && Number.isFinite(paneId)) {
      return { kind: 'terminal', tabId, paneId }
    }
    return null
  }

  if (activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
    return { kind: 'text', element: activeElement }
  }

  if (activeElement instanceof HTMLElement && activeElement.isContentEditable) {
    return { kind: 'contentEditable', element: activeElement }
  }

  return null
}

/**
 * Resolves true once all of the text is in the field. False means it was skipped or cut short,
 * and for terminals, whose paste completes elsewhere, that delivery is unconfirmed.
 */
export function insertText(text: string, target: DictationInsertionTarget): Promise<boolean> {
  if (target.kind === 'terminal') {
    document.dispatchEvent(
      new CustomEvent('dictation:insertText', {
        detail: { text, tabId: target.tabId, paneId: target.paneId }
      })
    )
    return Promise.resolve(false)
  }

  if (target.kind === 'text') {
    const element = target.element
    if (!element.isConnected) {
      return Promise.resolve(false)
    }
    return pasteTextIntoTextControl(element, text, {
      source: 'programmatic',
      inputType: 'insertText',
      canContinue: (candidate) => candidate.ownerDocument.activeElement === candidate
    }).then(
      (result) => result.status === 'pasted',
      () => false
    )
  }

  return insertTextIntoContentEditableTarget(target.element, text).catch(() => false)
}

function findClosestEditorElement(element: HTMLElement): HTMLElement | null {
  return element.closest('.ProseMirror, [contenteditable="true"]')
}

async function insertTextIntoContentEditableTarget(
  element: HTMLElement,
  text: string
): Promise<boolean> {
  const directByteLength = measureTextControlPasteByteLength(text, {
    stopAfterBytes: TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
  })
  if (directByteLength.byteLength === 0) {
    return false
  }
  if (!isContentEditableDictationTargetCurrent(element)) {
    return false
  }
  const editorElement = findClosestEditorElement(element) ?? element
  if (!directByteLength.exceededLimit) {
    return insertContentEditableDictationChunk(element, editorElement, text)
  }

  const maxByteLength = await measureTextControlPasteByteLengthWithYield(text, {
    stopAfterBytes: TEXT_CONTROL_PASTE_MAX_BYTES
  })
  if (maxByteLength.exceededLimit) {
    return false
  }

  let textIndex = 0
  // Why: dictation can produce paste-sized text; chunking avoids one large
  // execCommand while keeping editor beforeinput/input semantics.
  while (textIndex < text.length) {
    if (!isContentEditableDictationTargetCurrent(element)) {
      return false
    }
    const nextIndex = getUtf8ChunkEndIndex(text, textIndex, TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES)
    if (
      !insertContentEditableDictationChunk(element, editorElement, text.slice(textIndex, nextIndex))
    ) {
      return false
    }
    textIndex = nextIndex
    if (textIndex < text.length) {
      await yieldToEventLoop()
    }
  }
  return true
}

function insertContentEditableDictationChunk(
  element: HTMLElement,
  editorElement: HTMLElement,
  text: string
): boolean {
  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: text
  })
  if (!editorElement.dispatchEvent(beforeInput)) {
    return false
  }
  if (element.ownerDocument.execCommand?.('insertText', false, text) === true) {
    return true
  }
  const selection = element.ownerDocument.getSelection()
  if (selection && selection.rangeCount > 0) {
    const range = selection.getRangeAt(0)
    range.deleteContents()
    const textNode = element.ownerDocument.createTextNode(text)
    range.insertNode(textNode)
    range.setStartAfter(textNode)
    range.collapse(true)
    selection.removeAllRanges()
    selection.addRange(range)
  }
  editorElement.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
  )
  return true
}

function isContentEditableDictationTargetCurrent(element: HTMLElement): boolean {
  return element.isConnected && element.contains(element.ownerDocument.activeElement)
}
