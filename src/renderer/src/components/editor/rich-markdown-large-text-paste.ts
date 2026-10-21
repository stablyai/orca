import type { Editor } from '@tiptap/react'
import { TextSelection, type SelectionBookmark, type Transaction } from '@tiptap/pm/state'
import { closeHistory } from '@tiptap/pm/history'
import { toast } from 'sonner'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'
import {
  getUtf8ChunkEndIndex,
  isUtf8ByteLengthWithinLimit
} from '../../../../shared/utf8-byte-limits'
import {
  measureTextControlPasteByteLength,
  measureTextControlPasteByteLengthWithYield
} from '@/lib/text-control-paste'
import { translate } from '@/i18n/i18n'
import { getRichMarkdownImageResolverContextVersion } from './rich-markdown-image-context'
import { trackRichMarkdownLargePasteHistory } from './rich-markdown-large-paste-history'
import {
  captureRichMarkdownClipboardInsertionOrder,
  richMarkdownClipboardInsertionOrderKey
} from './rich-markdown-clipboard-insertion-order'

export const RICH_MARKDOWN_PASTE_DIRECT_MAX_BYTES = 64 * 1024
export const RICH_MARKDOWN_PASTE_CHUNK_MAX_BYTES = 16 * 1024
export const RICH_MARKDOWN_PASTE_MAX_BYTES = 16 * 1024 * 1024

type RichMarkdownLargeTextPasteOptions = {
  directMaxBytes?: number
  chunkMaxBytes?: number
  maxBytes?: number
  measureYieldAfterCodeUnits?: number
  yieldToEventLoop?: () => Promise<void>
  canContinue?: (editor: Editor) => boolean
  plainTextOverride?: string
  htmlTextOverride?: string
}

export type RichMarkdownLargeTextPasteResult =
  | { status: 'ignored'; reason: 'no-editor' | 'empty' | 'small' | 'already-handled' }
  | { status: 'handled'; chunksWritten: number; byteLength: number }
  | { status: 'rejected'; reason: 'target-unavailable' | 'too-large'; byteLength: number }
  | {
      status: 'cancelled'
      reason: 'target-unavailable'
      byteLength: number
      chunksWritten: number
    }

function isEditorAvailable(
  editor: Editor,
  canContinue: RichMarkdownLargeTextPasteOptions['canContinue']
): boolean {
  return (
    !editor.isDestroyed &&
    editor.isEditable &&
    editor.view.dom.isConnected &&
    (canContinue?.(editor) ?? true)
  )
}

function isEditorPasteTargetCurrent(editor: Editor, targetDom: HTMLElement): boolean {
  return (
    isEditorAvailable(editor, undefined) && editor.view.dom === targetDom && editor.view.hasFocus()
  )
}

async function executeRichMarkdownLargeTextPaste(
  editor: Editor,
  text: string,
  options: RichMarkdownLargeTextPasteOptions
): Promise<RichMarkdownLargeTextPasteResult> {
  const chunkMaxBytes = Math.max(1, options.chunkMaxBytes ?? RICH_MARKDOWN_PASTE_CHUNK_MAX_BYTES)
  const yieldBetweenBatches = options.yieldToEventLoop ?? yieldToEventLoop
  const contextVersion = getRichMarkdownImageResolverContextVersion(editor)
  const targetDom = editor.view.dom
  const requestOrder = captureRichMarkdownClipboardInsertionOrder(editor)
  let document = editor.state.doc
  let bookmark = editor.state.selection.getBookmark()
  const pasteMarks = editor.state.storedMarks
  let insertionTransaction: Transaction | null = null
  let insertionEnd: SelectionBookmark | null = null
  let active = true
  let pasteTime: number | null = null
  let byteLength = 0
  let textIndex = 0
  let chunksWritten = 0
  const history = trackRichMarkdownLargePasteHistory(editor, () => {
    pasteTime = null
  })

  const dispose = (): void => {
    if (!active) {
      return
    }
    active = false
    editor.off('transaction', mapTransactions)
    editor.off('destroy', dispose)
    history.dispose()
  }
  const mapTransactions = ({
    transaction,
    appendedTransactions
  }: {
    transaction: Transaction
    appendedTransactions: Transaction[]
  }): void => {
    if (!transaction.before.eq(document)) {
      dispose()
      return
    }
    const ownChunk = transaction === insertionTransaction
    const insertionOrder: unknown = transaction.getMeta(richMarkdownClipboardInsertionOrderKey)
    const assoc = typeof insertionOrder === 'number' && insertionOrder < requestOrder ? 1 : -1
    for (const next of [transaction, ...appendedTransactions]) {
      if (next === insertionTransaction && insertionEnd) {
        bookmark = insertionEnd
        insertionTransaction = null
      } else if (!next.doc.eq(document)) {
        const selection = bookmark.resolve(document)
        let ranges = selection.ranges.map(({ $from, $to }) => ({
          from: $from.pos,
          to: $to.pos
        }))
        for (const map of next.mapping.maps) {
          const overlaps = ranges.some((range) => {
            let changed = false
            map.forEach((from, to) => {
              changed ||=
                range.from === range.to
                  ? to > from && from <= range.from && to >= range.to
                  : to > from
                    ? from < range.to && to > range.from
                    : from > range.from && from < range.to
            })
            return changed
          })
          if (overlaps && !ownChunk) {
            dispose()
            return
          }
          ranges = ranges.map((range) => ({
            from: map.map(range.from, range.from === range.to ? assoc : 1),
            to: map.map(range.to, range.from === range.to ? assoc : -1)
          }))
        }
        const range = ranges[0]
        bookmark =
          selection instanceof TextSelection && range
            ? TextSelection.create(
                next.doc,
                selection.anchor <= selection.head ? range.from : range.to,
                selection.anchor <= selection.head ? range.to : range.from
              ).getBookmark()
            : bookmark.map(next.mapping)
        if (!(selection instanceof TextSelection)) {
          const mapped = bookmark.resolve(next.doc)
          const expectedRanges = new Set(ranges.map((range) => `${range.from}:${range.to}`))
          // Native selections must not expand to include content added during the paste.
          if (
            mapped.constructor !== selection.constructor ||
            mapped.ranges.length !== ranges.length ||
            mapped.ranges.some(({ $from, $to }) => !expectedRanges.has(`${$from.pos}:${$to.pos}`))
          ) {
            dispose()
            return
          }
        }
      }
      document = next.doc
    }
  }

  editor.on('transaction', mapTransactions)
  editor.on('destroy', dispose)
  try {
    const measurement = await measureTextControlPasteByteLengthWithYield(text, {
      stopAfterBytes: options.maxBytes ?? RICH_MARKDOWN_PASTE_MAX_BYTES,
      yieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
      yieldToEventLoop: yieldBetweenBatches
    })
    byteLength = measurement.byteLength
    if (measurement.exceededLimit) {
      return { status: 'rejected', reason: 'too-large', byteLength }
    }
    while (textIndex < text.length) {
      if (
        !active ||
        !isEditorPasteTargetCurrent(editor, targetDom) ||
        !(options.canContinue?.(editor) ?? true) ||
        getRichMarkdownImageResolverContextVersion(editor) !== contextVersion ||
        !editor.state.doc.eq(document)
      ) {
        return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
      }
      const selection = bookmark.resolve(document)
      const liveSelection = editor.state.selection
      const liveMarks = editor.state.storedMarks
      const nextIndex = getUtf8ChunkEndIndex(text, textIndex, chunkMaxBytes)
      const tr = editor.state.tr
        .setSelection(selection)
        .setStoredMarks(pasteMarks)
        .insertText(text.slice(textIndex, nextIndex))
        .setMeta(richMarkdownClipboardInsertionOrderKey, requestOrder)
      if (pasteTime === null) {
        closeHistory(tr)
        pasteTime = tr.time
      }
      tr.setTime(pasteTime)
      insertionEnd = tr.selection.getBookmark()
      if (!liveSelection.eq(selection)) {
        tr.setSelection(liveSelection.map(tr.doc, tr.mapping))
      }
      tr.setStoredMarks(liveMarks)
      // Own chunks advance the paste bookmark without following a moved live caret.
      insertionTransaction = tr
      history.dispatchChunk(tr)
      if (insertionTransaction) {
        return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
      }
      textIndex = nextIndex
      chunksWritten += 1
      if (textIndex < text.length) {
        await yieldBetweenBatches()
      }
    }
    return { status: 'handled', chunksWritten, byteLength }
  } finally {
    dispose()
    if (
      chunksWritten &&
      !history.hasExternalBoundary() &&
      !editor.isDestroyed &&
      editor.view.dom === targetDom &&
      getRichMarkdownImageResolverContextVersion(editor) === contextVersion
    ) {
      editor.view.dispatch(closeHistory(editor.state.tr))
    }
  }
}

function showRichMarkdownLargePasteLimitError(): void {
  toast.error(
    translate('auto.components.editor.richMarkdownLargeTextPaste.tooLarge', 'Paste is too large.')
  )
}

export function handleRichMarkdownLargeTextPaste(
  editor: Editor | null,
  event: ClipboardEvent,
  options: RichMarkdownLargeTextPasteOptions = {}
): boolean {
  if (event.defaultPrevented || !editor) {
    return false
  }

  const text = options.plainTextOverride ?? event.clipboardData?.getData('text/plain') ?? ''
  const html = options.htmlTextOverride ?? event.clipboardData?.getData('text/html') ?? ''
  const directMaxBytes = options.directMaxBytes ?? RICH_MARKDOWN_PASTE_DIRECT_MAX_BYTES
  const maxBytes = options.maxBytes ?? RICH_MARKDOWN_PASTE_MAX_BYTES
  const ownershipMeasurement = measureTextControlPasteByteLength(text, {
    stopAfterBytes: Math.min(directMaxBytes, maxBytes)
  })
  if (
    !ownershipMeasurement.exceededLimit &&
    ownershipMeasurement.byteLength <= directMaxBytes &&
    isUtf8ByteLengthWithinLimit(html, directMaxBytes)
  ) {
    return false
  }

  event.preventDefault()
  if (!text || (maxBytes <= directMaxBytes && ownershipMeasurement.exceededLimit)) {
    showRichMarkdownLargePasteLimitError()
    return true
  }

  if (!isEditorAvailable(editor, options.canContinue)) {
    return true
  }
  // Why: large rich-editor text or HTML paste bypasses ProseMirror's
  // synchronous parser and writes bounded plain-text fallback transactions.
  void executeRichMarkdownLargeTextPaste(editor, text, options).then((result) => {
    if (result.status === 'rejected' && result.reason === 'too-large') {
      showRichMarkdownLargePasteLimitError()
    } else if (result.status === 'cancelled') {
      toast.info(
        result.chunksWritten
          ? translate(
              'auto.components.editor.richMarkdownLargeTextPaste.stopped',
              'Large paste stopped before it finished.'
            )
          : translate(
              'auto.components.editor.richMarkdownLargeTextPaste.cancelled',
              'Large paste cancelled because its original target changed.'
            )
      )
    }
  })

  return true
}
