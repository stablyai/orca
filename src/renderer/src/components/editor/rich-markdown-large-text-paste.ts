import type { Editor } from '@tiptap/react'
import { toast } from 'sonner'
import {
  measureTextControlPasteByteLength,
  measureTextControlPasteByteLengthWithYield
} from '@/lib/text-control-paste'
import { translate } from '@/i18n/i18n'

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

function getCodePointUtf8ByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) {
    return 1
  }
  if (codePoint <= 0x7ff) {
    return 2
  }
  if (codePoint <= 0xffff) {
    return 3
  }
  return 4
}

function isTextByteLengthOverLimit(text: string, maxBytes: number): boolean {
  if (text.length === 0) {
    return false
  }
  if (text.length > maxBytes) {
    return true
  }

  let byteLength = 0
  for (let index = 0; index < text.length; index += 1) {
    const codePoint = text.codePointAt(index) ?? 0
    byteLength += getCodePointUtf8ByteLength(codePoint)
    if (byteLength > maxBytes) {
      return true
    }
    if (codePoint > 0xffff) {
      index += 1
    }
  }
  return false
}

function getNextChunkBoundary(text: string, startIndex: number, maxBytes: number): number {
  let byteLength = 0
  let index = startIndex

  while (index < text.length) {
    const codePoint = text.codePointAt(index) ?? 0
    const codeUnitLength = codePoint > 0xffff ? 2 : 1
    const nextByteLength = getCodePointUtf8ByteLength(codePoint)

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

function isEditorAvailable(
  editor: Editor,
  canContinue: RichMarkdownLargeTextPasteOptions['canContinue']
): boolean {
  return !editor.isDestroyed && editor.view.dom.isConnected && (canContinue?.(editor) ?? true)
}

function isEditorPasteTargetCurrent(editor: Editor, targetDom: HTMLElement): boolean {
  return (
    !editor.isDestroyed &&
    editor.view.dom === targetDom &&
    targetDom.isConnected &&
    editor.view.hasFocus()
  )
}

function readPlainText(event: ClipboardEvent): string {
  return event.clipboardData?.getData('text/plain') ?? ''
}

function readHtmlText(event: ClipboardEvent): string {
  return event.clipboardData?.getData('text/html') ?? ''
}

function shouldHandleLargeRichMarkdownPaste({
  plainTextByteLength,
  plainTextExceededLimit,
  htmlText,
  maxDirect
}: {
  plainTextByteLength: number
  plainTextExceededLimit: boolean
  htmlText: string
  maxDirect: number
}): boolean {
  if (plainTextExceededLimit || plainTextByteLength > maxDirect) {
    return true
  }
  return isTextByteLengthOverLimit(htmlText, maxDirect)
}

async function insertRichMarkdownTextInChunks(
  editor: Editor,
  text: string,
  byteLength: number,
  options: RichMarkdownLargeTextPasteOptions
): Promise<RichMarkdownLargeTextPasteResult> {
  const chunkMaxBytes = options.chunkMaxBytes ?? RICH_MARKDOWN_PASTE_CHUNK_MAX_BYTES
  let textIndex = 0
  let chunksWritten = 0

  while (textIndex < text.length) {
    if (!isEditorAvailable(editor, options.canContinue)) {
      return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
    }

    const nextIndex = getNextChunkBoundary(text, textIndex, chunkMaxBytes)
    const chunk = text.slice(textIndex, nextIndex)
    editor.view.dispatch(editor.state.tr.insertText(chunk))
    textIndex = nextIndex
    chunksWritten += 1

    if (textIndex < text.length) {
      await (options.yieldToEventLoop ?? yieldToEventLoop)()
    }
  }

  return { status: 'handled', chunksWritten, byteLength }
}

async function executeRichMarkdownLargeTextPaste(
  editor: Editor,
  text: string,
  options: RichMarkdownLargeTextPasteOptions
): Promise<RichMarkdownLargeTextPasteResult> {
  const maxBytes = options.maxBytes ?? RICH_MARKDOWN_PASTE_MAX_BYTES
  const byteLengthMeasurement = await measureTextControlPasteByteLengthWithYield(text, {
    stopAfterBytes: maxBytes,
    yieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
    yieldToEventLoop: options.yieldToEventLoop
  })
  if (byteLengthMeasurement.exceededLimit) {
    return { status: 'rejected', reason: 'too-large', byteLength: byteLengthMeasurement.byteLength }
  }
  return insertRichMarkdownTextInChunks(editor, text, byteLengthMeasurement.byteLength, options)
}

export function handleRichMarkdownLargeTextPaste(
  editor: Editor | null,
  event: ClipboardEvent,
  options: RichMarkdownLargeTextPasteOptions = {}
): boolean {
  if (event.defaultPrevented) {
    return false
  }
  if (!editor) {
    return false
  }

  const text = readPlainText(event)
  const html = readHtmlText(event)
  const directMaxBytes = options.directMaxBytes ?? RICH_MARKDOWN_PASTE_DIRECT_MAX_BYTES
  const maxBytes = options.maxBytes ?? RICH_MARKDOWN_PASTE_MAX_BYTES
  const ownershipMeasurement = measureTextControlPasteByteLength(text, {
    stopAfterBytes: Math.min(directMaxBytes, maxBytes)
  })
  if (
    !shouldHandleLargeRichMarkdownPaste({
      plainTextByteLength: ownershipMeasurement.byteLength,
      plainTextExceededLimit: ownershipMeasurement.exceededLimit,
      htmlText: html,
      maxDirect: directMaxBytes
    })
  ) {
    return false
  }

  event.preventDefault()
  if (!text || (maxBytes <= directMaxBytes && ownershipMeasurement.exceededLimit)) {
    toast.error(
      translate('auto.components.editor.richMarkdownLargeTextPaste.tooLarge', 'Paste is too large.')
    )
    return true
  }

  if (!isEditorAvailable(editor, options.canContinue)) {
    return true
  }
  const targetDom = editor.view.dom
  const guardedOptions: RichMarkdownLargeTextPasteOptions = {
    ...options,
    canContinue: (candidate) =>
      isEditorPasteTargetCurrent(candidate, targetDom) && (options.canContinue?.(candidate) ?? true)
  }

  // Why: large rich-editor text or HTML paste bypasses ProseMirror's
  // synchronous parser and writes bounded plain-text fallback transactions.
  void executeRichMarkdownLargeTextPaste(editor, text, guardedOptions).then((result) => {
    if (result.status === 'rejected' && result.reason === 'too-large') {
      toast.error(
        translate(
          'auto.components.editor.richMarkdownLargeTextPaste.tooLarge',
          'Paste is too large.'
        )
      )
    }
  })

  return true
}
