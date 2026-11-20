import {
  nativeChatSelectionText,
  selectedTextEdges
} from '../../../../../shared/native-chat/input/quotes/native-chat-quote-selection'

const TRANSCRIPT_SELECTOR = '[data-native-chat-scroll]'
const ROW_SELECTOR = '[data-native-chat-selection-row]'
// Why: a selection that starts or ends on a control is the control's, not a reference.
const CONTROL_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="tab"]',
  '[data-native-chat-find-skip]'
].join(',')

/** A transcript row's stable identity and the text the reader selected there. */
export type NativeChatSelectionReference = {
  sourceRowId: string
  text: string
}

export type NativeChatTranscriptRowSelection = NativeChatSelectionReference & { range: Range }

export function readNativeChatTranscriptSelection(root: HTMLElement): string {
  const found = readTranscriptRange(root)
  if (!found) {
    return ''
  }
  return nativeChatSelectionText(found.selection, found.transcript)
}

/** The selection when it lies wholly inside one transcript row, never across rows or controls. */
export function readNativeChatTranscriptRowSelection(
  root: HTMLElement
): NativeChatTranscriptRowSelection | null {
  const found = readTranscriptRange(root)
  if (!found) {
    return null
  }
  const edges = selectedTextEdges(found.range)
  if (
    !edges ||
    !edges.first.isConnected ||
    !edges.last.isConnected ||
    edges.first.parentElement?.closest(CONTROL_SELECTOR) !== null ||
    edges.last.parentElement?.closest(CONTROL_SELECTOR) !== null
  ) {
    return null
  }
  const firstRow = edges.first.parentElement?.closest<HTMLElement>(ROW_SELECTOR)
  const lastRow = edges.last.parentElement?.closest<HTMLElement>(ROW_SELECTOR)
  // A nested row (a thought inside a run) is its own row; selecting across it crosses rows.
  if (!firstRow || firstRow !== lastRow || !found.transcript.contains(firstRow)) {
    return null
  }
  // Endpoints can share the outer row while a nested row's text sits between them.
  for (const row of Array.from(firstRow.querySelectorAll(ROW_SELECTOR))) {
    if (found.range.intersectsNode(row)) {
      return null
    }
  }
  const sourceRowId = firstRow.getAttribute('data-native-chat-selection-row')
  if (!sourceRowId) {
    return null
  }
  const text = nativeChatSelectionText(found.selection, found.transcript).trim()
  return text ? { sourceRowId, text, range: found.range } : null
}

function readTranscriptRange(
  root: HTMLElement
): { selection: Selection; transcript: HTMLElement; range: Range } | null {
  const selection = window.getSelection()
  // The conversation's own list comes first; a shown subagent view is a second, read-only list.
  const transcript = root.querySelector<HTMLElement>(TRANSCRIPT_SELECTOR)
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount !== 1 ||
    !transcript ||
    !transcript.contains(selection.anchorNode) ||
    !transcript.contains(selection.focusNode)
  ) {
    return null
  }
  const range = selection.getRangeAt(0)
  if (!transcript.contains(range.commonAncestorContainer)) {
    return null
  }
  return { selection, transcript, range }
}
