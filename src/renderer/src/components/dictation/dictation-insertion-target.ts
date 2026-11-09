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
import { dictationSeparators } from '../../../../shared/dictation-transcript-spacing'
import { DICTATION_FOCUS_INPUT_EVENT } from './dictation-control-events'

/** Each returns whether the text landed. */
type ComposerInsert = (text: string) => boolean
type TerminalInsert = (text: string, paneId: number) => Promise<boolean>

export type DictationInsertionTarget =
  | { kind: 'composer'; insert: ComposerInsert; root: HTMLElement }
  | { kind: 'terminal'; tabId: string; paneId: number }
  | { kind: 'text'; element: HTMLInputElement | HTMLTextAreaElement }
  | { kind: 'contentEditable'; element: HTMLElement }

const composerTargets = new WeakMap<HTMLElement, ComposerInsert>()
const terminalTargets = new Map<string, TerminalInsert>()

/** A late transcript lands in the composer's draft even after focus left its editor; the composer spaces it. */
export function registerDictationComposerTarget(
  root: HTMLElement,
  insert: ComposerInsert
): () => void {
  composerTargets.set(root, insert)
  return () => {
    if (composerTargets.get(root) === insert) {
      composerTargets.delete(root)
    }
  }
}

/** A late transcript lands in the pane it started in, even after its tab was switched away. */
export function registerDictationTerminalTarget(tabId: string, insert: TerminalInsert): () => void {
  terminalTargets.set(tabId, insert)
  return () => {
    if (terminalTargets.get(tabId) === insert) {
      terminalTargets.delete(tabId)
    }
  }
}

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

  for (let root: Element | null = activeElement; root; root = root.parentElement) {
    const insert = root instanceof HTMLElement ? composerTargets.get(root) : undefined
    if (insert && root instanceof HTMLElement) {
      return { kind: 'composer', insert, root }
    }
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

function spaced(text: string, before: string, after: string): string {
  const { leading, trailing } = dictationSeparators(before, text, after)
  return `${leading}${text}${trailing}`
}

function readSelectionRangeIn(element: HTMLElement): Range | null {
  const selection = element.ownerDocument.getSelection()
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  return range && element.contains(range.commonAncestorContainer) ? range : null
}

const CONTENT_EDITABLE_BLOCK_SELECTOR =
  'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, div'

/** The selection's neighbours within its own block, so a new paragraph's start has none. */
function readContentEditableNeighbours(element: HTMLElement): { before: string; after: string } {
  const range = readSelectionRangeIn(element)
  if (!range) {
    return { before: '', after: '' }
  }
  const blockOf = (node: Node): Node => {
    const block = (node instanceof Element ? node : node.parentElement)?.closest(
      CONTENT_EDITABLE_BLOCK_SELECTOR
    )
    return block && element.contains(block) ? block : element
  }
  const before = element.ownerDocument.createRange()
  before.selectNodeContents(blockOf(range.startContainer))
  before.setEnd(range.startContainer, range.startOffset)
  const after = element.ownerDocument.createRange()
  after.selectNodeContents(blockOf(range.endContainer))
  after.setStart(range.endContainer, range.endOffset)
  return { before: before.toString(), after: after.toString() }
}

/**
 * Spaces dictated text from the text around where it lands, inserts it, and resolves whether it landed.
 * A terminal's line can't be read, so `previousText` (the session's last landed text) stands in for it.
 */
export async function insertText(
  text: string,
  target: DictationInsertionTarget,
  previousText = ''
): Promise<boolean> {
  if (target.kind === 'composer') {
    return target.insert(text)
  }
  if (target.kind === 'terminal') {
    const insert = terminalTargets.get(target.tabId)
    return insert ? insert(spaced(text, previousText, ''), target.paneId) : false
  }
  if (target.kind === 'text') {
    const element = target.element
    if (!element.isConnected) {
      return false
    }
    const start = element.selectionStart ?? element.value.length
    const end = element.selectionEnd ?? start
    const result = await pasteTextIntoTextControl(
      element,
      spaced(text, element.value.slice(0, start), element.value.slice(end)),
      {
        source: 'programmatic',
        inputType: 'insertText',
        canContinue: (candidate) => candidate.ownerDocument.activeElement === candidate
      }
    )
    return result.status === 'pasted'
  }
  const { before, after } = readContentEditableNeighbours(target.element)
  return insertTextIntoContentEditableTarget(target.element, spaced(text, before, after))
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
    return true
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
  // Chunk paste-sized dictation while preserving editor beforeinput/input semantics.
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
  const range = readSelectionRangeIn(element)
  if (!range) {
    return false
  }
  range.deleteContents()
  const textNode = element.ownerDocument.createTextNode(text)
  range.insertNode(textNode)
  range.setStartAfter(textNode)
  range.collapse(true)
  const selection = element.ownerDocument.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  editorElement.dispatchEvent(
    new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })
  )
  return true
}

function isContentEditableDictationTargetCurrent(element: HTMLElement): boolean {
  return element.isConnected && element.contains(element.ownerDocument.activeElement)
}
