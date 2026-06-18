import {
  TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES,
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES,
  getTextControlPasteByteLength,
  measureTextControlPasteByteLength,
  measureTextControlPasteByteLengthWithYield,
  pasteTextIntoTextControl
} from '@/lib/text-control-paste'

export type DictationInsertionTarget =
  | { kind: 'terminal'; tabId: string; paneId: number }
  | { kind: 'text'; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'contentEditable'; element: HTMLElement }

export function captureInsertionTarget(): DictationInsertionTarget | null {
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

export function insertText(text: string, target: DictationInsertionTarget): void {
  if (target.kind === 'terminal') {
    document.dispatchEvent(
      new CustomEvent('dictation:insertText', {
        detail: { text, tabId: target.tabId, paneId: target.paneId }
      })
    )
    return
  }

  if (target.kind === 'text') {
    const element = target.element
    if (!element.isConnected) {
      return
    }
    void pasteTextIntoTextControl(element, text, {
      source: 'programmatic',
      inputType: 'insertText',
      canContinue: (candidate) => candidate.ownerDocument.activeElement === candidate
    }).catch(() => {})
    return
  }

  if (target.kind === 'contentEditable') {
    void insertTextIntoContentEditableTarget(target.element, text).catch(() => {})
  }
}

function findClosestEditorElement(element: HTMLElement): HTMLElement | null {
  return element.closest('.ProseMirror, [contenteditable="true"]')
}

async function insertTextIntoContentEditableTarget(
  element: HTMLElement,
  text: string
): Promise<void> {
  const directByteLength = measureTextControlPasteByteLength(text, {
    stopAfterBytes: TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
  })
  if (directByteLength.byteLength === 0) {
    return
  }
  if (!isContentEditableDictationTargetCurrent(element)) {
    return
  }
  const editorElement = findClosestEditorElement(element) ?? element
  if (!directByteLength.exceededLimit) {
    insertContentEditableDictationChunk(element, editorElement, text)
    return
  }

  const maxByteLength = await measureTextControlPasteByteLengthWithYield(text, {
    stopAfterBytes: TEXT_CONTROL_PASTE_MAX_BYTES
  })
  if (maxByteLength.exceededLimit) {
    return
  }

  let textIndex = 0
  // Why: dictation can produce paste-sized text; chunking avoids one large
  // execCommand while keeping editor beforeinput/input semantics.
  while (textIndex < text.length) {
    if (!isContentEditableDictationTargetCurrent(element)) {
      return
    }
    const nextIndex = getNextDictationChunkBoundary(
      text,
      textIndex,
      TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES
    )
    if (
      !insertContentEditableDictationChunk(element, editorElement, text.slice(textIndex, nextIndex))
    ) {
      return
    }
    textIndex = nextIndex
    if (textIndex < text.length) {
      await yieldToEventLoop()
    }
  }
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

function getNextDictationChunkBoundary(text: string, startIndex: number, maxBytes: number): number {
  let byteLength = 0
  let index = startIndex

  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0
    const codeUnitLength = codePoint > 0xffff ? 2 : 1
    const nextByteLength = getTextControlPasteByteLength(text.slice(index, index + codeUnitLength))

    if (byteLength > 0 && byteLength + nextByteLength > maxBytes) {
      break
    }
    byteLength += nextByteLength
    index += codeUnitLength
  }

  return index
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}
