import {
  createTextControlCancelledResult,
  createTextControlPastedResult,
  createTextControlRejectedResult,
  getTextControlPasteSource
} from './text-control-paste-diagnostics'
import {
  measurePastePayloadMetadata,
  measurePastePayloadMetadataWithYield
} from './paste-payload-metadata'
import {
  TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES,
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES,
  TEXT_CONTROL_PASTE_MEASURE_YIELD_CODE_UNITS,
  type TextControlPasteByteLengthMeasurement,
  type TextControlPasteOptions,
  type TextControlPastePayloadMeasurement,
  type TextControlPasteResult
} from './text-control-paste-model'

export {
  TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES,
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  TEXT_CONTROL_PASTE_MAX_BYTES,
  TEXT_CONTROL_PASTE_MEASURE_YIELD_CODE_UNITS
} from './text-control-paste-model'
export type {
  TextControlPasteByteLengthMeasurement,
  TextControlPasteOptions,
  TextControlPastePayloadMeasurement,
  TextControlPasteResult,
  TextControlPasteSource
} from './text-control-paste-model'

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

export function measureTextControlPasteByteLength(
  text: string,
  options: { stopAfterBytes?: number } = {}
): TextControlPasteByteLengthMeasurement {
  const { byteLength, exceededLimit } = measurePastePayloadMetadata(text, options)
  return { byteLength, exceededLimit }
}

export function getTextControlPasteByteLength(text: string): number {
  return measureTextControlPasteByteLength(text).byteLength
}

export async function measureTextControlPasteByteLengthWithYield(
  text: string,
  options: {
    stopAfterBytes: number
    yieldAfterCodeUnits?: number
    yieldToEventLoop?: () => Promise<void>
  }
): Promise<TextControlPasteByteLengthMeasurement> {
  const { byteLength, exceededLimit } = await measurePastePayloadMetadataWithYield(text, {
    stopAfterBytes: options.stopAfterBytes,
    yieldAfterCodeUnits: options.yieldAfterCodeUnits ?? TEXT_CONTROL_PASTE_MEASURE_YIELD_CODE_UNITS,
    yieldToEventLoop: options.yieldToEventLoop
  })
  return { byteLength, exceededLimit }
}

async function measureTextControlPasteForExecution(
  text: string,
  options: Pick<
    TextControlPasteOptions,
    | 'directMaxBytes'
    | 'maxBytes'
    | 'measureYieldAfterCodeUnits'
    | 'measuredByteLength'
    | 'yieldToEventLoop'
  >
): Promise<TextControlPastePayloadMeasurement> {
  const maxBytes = options.maxBytes ?? TEXT_CONTROL_PASTE_MAX_BYTES
  if (options.measuredByteLength !== undefined) {
    return {
      byteLength: options.measuredByteLength,
      exceededLimit: options.measuredByteLength > maxBytes
    }
  }

  const directMaxBytes = options.directMaxBytes ?? TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
  const preflightLimit = Math.min(directMaxBytes, maxBytes)
  const preflightMeasurement = measurePastePayloadMetadata(text, {
    stopAfterBytes: preflightLimit
  })
  if (!preflightMeasurement.exceededLimit || preflightLimit === maxBytes) {
    return preflightMeasurement
  }

  return measurePastePayloadMetadataWithYield(text, {
    stopAfterBytes: maxBytes,
    yieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
    yieldToEventLoop: options.yieldToEventLoop
  })
}

export function shouldHandleTextControlPaste(
  text: string,
  options: Pick<TextControlPasteOptions, 'directMaxBytes' | 'maxBytes' | 'measuredByteLength'> = {}
): boolean {
  if (!text) {
    return false
  }
  const maxBytes = options.maxBytes ?? TEXT_CONTROL_PASTE_MAX_BYTES
  const measurement =
    options.measuredByteLength === undefined
      ? measureTextControlPasteByteLength(text, { stopAfterBytes: maxBytes })
      : {
          byteLength: options.measuredByteLength,
          exceededLimit: options.measuredByteLength > maxBytes
        }
  const directMaxBytes = options.directMaxBytes ?? TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
  return measurement.exceededLimit || measurement.byteLength > directMaxBytes
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

function dispatchTextControlInputEvent(
  target: HTMLInputElement | HTMLTextAreaElement,
  data: string | null,
  inputType: string
): void {
  const event =
    typeof InputEvent === 'function'
      ? new InputEvent('input', {
          bubbles: true,
          cancelable: false,
          data,
          inputType
        })
      : new Event('input', { bubbles: true, cancelable: false })
  target.dispatchEvent(event)
}

function isTextControlPasteTargetAvailable(
  target: HTMLInputElement | HTMLTextAreaElement,
  canContinue: TextControlPasteOptions['canContinue']
): boolean {
  return (
    target.isConnected && !target.disabled && !target.readOnly && (canContinue?.(target) ?? true)
  )
}

function getSelectionRange(target: HTMLInputElement | HTMLTextAreaElement): {
  start: number
  end: number
} {
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? start
  return {
    start: Math.min(start, end),
    end: Math.max(start, end)
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0))
}

function defaultNow(): number {
  return globalThis.performance?.now?.() ?? Date.now()
}

export async function pasteTextIntoTextControl(
  target: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  options: TextControlPasteOptions = {}
): Promise<TextControlPasteResult> {
  const source = getTextControlPasteSource(options.source)
  const now = options.now ?? defaultNow
  const startedAtMs = now()
  const getDurationMs = (): number => Math.max(0, now() - startedAtMs)
  const maxBytes = options.maxBytes ?? TEXT_CONTROL_PASTE_MAX_BYTES
  const directMaxBytes = options.directMaxBytes ?? TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
  const pastePayloadMeasurement = await measureTextControlPasteForExecution(text, {
    directMaxBytes,
    maxBytes,
    measuredByteLength: options.measuredByteLength,
    measureYieldAfterCodeUnits: options.measureYieldAfterCodeUnits,
    yieldToEventLoop: options.yieldToEventLoop
  })
  const { byteLength } = pastePayloadMeasurement
  if (byteLength === 0) {
    return createTextControlRejectedResult(
      'empty',
      pastePayloadMeasurement,
      source,
      getDurationMs()
    )
  }

  const chunkMaxBytes = options.chunkMaxBytes ?? TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES
  const continuePaste = options.canContinue
  const inputType = options.inputType ?? 'insertFromPaste'

  if (pastePayloadMeasurement.exceededLimit) {
    return createTextControlRejectedResult(
      'too-large',
      pastePayloadMeasurement,
      source,
      getDurationMs()
    )
  }

  if (!isTextControlPasteTargetAvailable(target, continuePaste)) {
    return createTextControlRejectedResult(
      'target-unavailable',
      pastePayloadMeasurement,
      source,
      getDurationMs()
    )
  }

  try {
    target.focus()

    if (byteLength <= directMaxBytes) {
      const { start, end } = getSelectionRange(target)
      target.setRangeText(text, start, end, 'end')
      dispatchTextControlInputEvent(target, text, inputType)
      return createTextControlPastedResult({
        byteLength,
        chunksWritten: 1,
        hasControlSequences: pastePayloadMeasurement.hasControlSequences,
        lineCount: pastePayloadMeasurement.lineCount,
        mode: 'direct',
        source,
        durationMs: getDurationMs()
      })
    }

    const { start, end } = getSelectionRange(target)
    if (start !== end) {
      target.setRangeText('', start, end, 'end')
    }

    let chunksWritten = 0
    let textIndex = 0
    // Why: large text controls keep literal content; chunking only changes
    // delivery cadence so the renderer can yield between DOM mutations.
    while (textIndex < text.length) {
      if (!isTextControlPasteTargetAvailable(target, continuePaste)) {
        if (chunksWritten > 0 && target.isConnected) {
          dispatchTextControlInputEvent(target, null, inputType)
        }
        return createTextControlCancelledResult({
          byteLength,
          chunksWritten,
          hasControlSequences: pastePayloadMeasurement.hasControlSequences,
          lineCount: pastePayloadMeasurement.lineCount,
          source,
          durationMs: getDurationMs()
        })
      }

      const nextIndex = getNextChunkBoundary(text, textIndex, chunkMaxBytes)
      const chunk = text.slice(textIndex, nextIndex)
      const caret = target.selectionStart ?? target.value.length
      target.setRangeText(chunk, caret, caret, 'end')
      textIndex = nextIndex
      chunksWritten += 1

      if (textIndex < text.length) {
        await (options.yieldToEventLoop ?? yieldToEventLoop)()
      }
    }

    dispatchTextControlInputEvent(target, null, inputType)
    return createTextControlPastedResult({
      byteLength,
      chunksWritten,
      hasControlSequences: pastePayloadMeasurement.hasControlSequences,
      lineCount: pastePayloadMeasurement.lineCount,
      mode: 'chunked',
      source,
      durationMs: getDurationMs()
    })
  } catch {
    return createTextControlRejectedResult(
      'target-unavailable',
      pastePayloadMeasurement,
      source,
      getDurationMs()
    )
  }
}
