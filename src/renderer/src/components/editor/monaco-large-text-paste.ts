import type { editor } from 'monaco-editor'
import {
  measureTextControlPasteByteLength,
  measureTextControlPasteByteLengthWithYield
} from '@/lib/text-control-paste'

export const MONACO_PASTE_DIRECT_MAX_BYTES = 64 * 1024
export const MONACO_PASTE_CHUNK_MAX_BYTES = 16 * 1024
export const MONACO_PASTE_MAX_BYTES = 16 * 1024 * 1024

export type MonacoLargeTextPasteResult =
  | { status: 'ignored'; reason: 'already-handled' | 'empty' | 'small' | 'read-only' | 'no-editor' }
  | { status: 'handled' }
  | {
      status: 'pasted'
      mode: 'chunked'
      byteLength: number
      chunksWritten: number
    }
  | {
      status: 'rejected'
      reason: 'target-unavailable' | 'too-large'
      byteLength: number
      chunksWritten: 0
    }
  | {
      status: 'cancelled'
      reason: 'target-unavailable'
      byteLength: number
      chunksWritten: number
    }

export type MonacoLargeTextPasteOptions = {
  directMaxBytes?: number
  chunkMaxBytes?: number
  maxBytes?: number
  measureYieldAfterCodeUnits?: number
  readOnly?: boolean
  yieldToEventLoop?: () => Promise<void>
  onPasteStart?: () => void
  onPasteResult?: (
    result: Exclude<MonacoLargeTextPasteResult, { status: 'ignored' | 'handled' }>
  ) => void
}

type MonacoPasteSnapshot = {
  container: HTMLElement
  model: editor.ITextModel
}

type Position = {
  lineNumber: number
  column: number
}

function getPlainTextFromPasteEvent(event: ClipboardEvent): string {
  return event.clipboardData?.getData('text/plain') ?? ''
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

function getEndPositionAfterInsert(start: Position, text: string): Position {
  let lineNumber = start.lineNumber
  let column = start.column
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index)
    if (codeUnit === 13) {
      lineNumber += 1
      column = 1
      if (text.charCodeAt(index + 1) === 10) {
        index += 1
      }
      continue
    }
    if (codeUnit === 10) {
      lineNumber += 1
      column = 1
      continue
    }
    column += 1
  }
  return { lineNumber, column }
}

function snapshotMonacoPasteTarget(
  monacoEditor: editor.IStandaloneCodeEditor
): MonacoPasteSnapshot | null {
  const model = monacoEditor.getModel()
  const container = monacoEditor.getContainerDomNode()
  if (!model || !container.isConnected || !monacoEditor.hasTextFocus()) {
    return null
  }
  return { container, model }
}

function isMonacoPasteTargetCurrent(
  monacoEditor: editor.IStandaloneCodeEditor,
  snapshot: MonacoPasteSnapshot
): boolean {
  return (
    monacoEditor.getModel() === snapshot.model &&
    monacoEditor.getContainerDomNode() === snapshot.container &&
    snapshot.container.isConnected &&
    monacoEditor.hasTextFocus()
  )
}

function setCollapsedSelection(
  monacoEditor: editor.IStandaloneCodeEditor,
  position: Position
): void {
  monacoEditor.setSelection({
    startLineNumber: position.lineNumber,
    startColumn: position.column,
    endLineNumber: position.lineNumber,
    endColumn: position.column
  })
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}

async function insertMonacoTextInChunks(
  monacoEditor: editor.IStandaloneCodeEditor,
  text: string,
  byteLength: number,
  options: MonacoLargeTextPasteOptions
): Promise<Exclude<MonacoLargeTextPasteResult, { status: 'ignored' | 'handled' }>> {
  const snapshot = snapshotMonacoPasteTarget(monacoEditor)
  if (!snapshot) {
    return { status: 'rejected', reason: 'target-unavailable', byteLength, chunksWritten: 0 }
  }

  const chunkMaxBytes = Math.max(1, options.chunkMaxBytes ?? MONACO_PASTE_CHUNK_MAX_BYTES)
  let textIndex = 0
  let chunksWritten = 0
  monacoEditor.pushUndoStop()

  while (textIndex < text.length) {
    if (!isMonacoPasteTargetCurrent(monacoEditor, snapshot)) {
      monacoEditor.pushUndoStop()
      return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
    }

    const selection = monacoEditor.getSelection()
    if (!selection) {
      monacoEditor.pushUndoStop()
      return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
    }

    const nextIndex = getNextChunkBoundary(text, textIndex, chunkMaxBytes)
    const chunk = text.slice(textIndex, nextIndex)
    const endPosition = getEndPositionAfterInsert(
      { lineNumber: selection.startLineNumber, column: selection.startColumn },
      chunk
    )
    const accepted = monacoEditor.executeEdits('orca-large-paste', [
      { range: selection, text: chunk, forceMoveMarkers: true }
    ])
    if (!accepted) {
      monacoEditor.pushUndoStop()
      return { status: 'cancelled', reason: 'target-unavailable', byteLength, chunksWritten }
    }
    setCollapsedSelection(monacoEditor, endPosition)
    textIndex = nextIndex
    chunksWritten += 1

    if (textIndex < text.length) {
      await (options.yieldToEventLoop ?? yieldToEventLoop)()
    }
  }

  monacoEditor.pushUndoStop()
  return { status: 'pasted', mode: 'chunked', byteLength, chunksWritten }
}

async function executeMonacoLargeTextPaste(
  monacoEditor: editor.IStandaloneCodeEditor,
  text: string,
  options: MonacoLargeTextPasteOptions
): Promise<Exclude<MonacoLargeTextPasteResult, { status: 'ignored' | 'handled' }>> {
  const maxBytes = options.maxBytes ?? MONACO_PASTE_MAX_BYTES
  const byteLengthMeasurement = await measureTextControlPasteByteLengthWithYield(text, {
    stopAfterBytes: maxBytes,
    yieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
    yieldToEventLoop: options.yieldToEventLoop
  })
  if (byteLengthMeasurement.exceededLimit) {
    return {
      status: 'rejected',
      reason: 'too-large',
      byteLength: byteLengthMeasurement.byteLength,
      chunksWritten: 0
    }
  }
  return insertMonacoTextInChunks(monacoEditor, text, byteLengthMeasurement.byteLength, options)
}

export function handleMonacoLargeTextPaste(
  monacoEditor: editor.IStandaloneCodeEditor | null,
  event: ClipboardEvent,
  options: MonacoLargeTextPasteOptions = {}
): MonacoLargeTextPasteResult {
  if (event.defaultPrevented) {
    return { status: 'ignored', reason: 'already-handled' }
  }
  if (options.readOnly) {
    return { status: 'ignored', reason: 'read-only' }
  }
  if (!monacoEditor?.getModel()) {
    return { status: 'ignored', reason: 'no-editor' }
  }

  const text = getPlainTextFromPasteEvent(event)
  if (!text) {
    return { status: 'ignored', reason: 'empty' }
  }

  const directMaxBytes = options.directMaxBytes ?? MONACO_PASTE_DIRECT_MAX_BYTES
  const maxBytes = options.maxBytes ?? MONACO_PASTE_MAX_BYTES
  const ownershipMeasurement = measureTextControlPasteByteLength(text, {
    stopAfterBytes: Math.min(directMaxBytes, maxBytes)
  })
  if (!ownershipMeasurement.exceededLimit) {
    return { status: 'ignored', reason: 'small' }
  }

  if (maxBytes <= directMaxBytes) {
    event.preventDefault()
    event.stopPropagation()
    const result = {
      status: 'rejected',
      reason: 'too-large',
      byteLength: ownershipMeasurement.byteLength,
      chunksWritten: 0
    } as const
    options.onPasteResult?.(result)
    return result
  }

  event.preventDefault()
  event.stopPropagation()

  options.onPasteStart?.()
  void executeMonacoLargeTextPaste(monacoEditor, text, options).then(options.onPasteResult)
  return { status: 'handled' }
}
