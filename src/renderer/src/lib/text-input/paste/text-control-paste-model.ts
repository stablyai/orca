export const TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES = 64 * 1024
export const TEXT_CONTROL_PASTE_CHUNK_MAX_BYTES = 16 * 1024
export const TEXT_CONTROL_PASTE_MAX_BYTES = 16 * 1024 * 1024
export const TEXT_CONTROL_PASTE_MEASURE_YIELD_CODE_UNITS = 64 * 1024

export type TextControlPasteSource = 'app-menu' | 'clipboard' | 'primary-selection' | 'programmatic'

export type TextControlPasteResult =
  | {
      status: 'pasted'
      mode: 'direct' | 'chunked'
      byteLength: number
      chunksWritten: number
      durationMs: number
      redactedDiagnostic: string
    }
  | {
      status: 'rejected'
      reason: 'empty' | 'target-unavailable' | 'too-large'
      byteLength: number
      chunksWritten: 0
      durationMs: number
      redactedDiagnostic: string
    }
  | {
      status: 'cancelled'
      reason: 'target-unavailable'
      byteLength: number
      chunksWritten: number
      durationMs: number
      redactedDiagnostic: string
    }

export type TextControlPasteOptions = {
  source?: TextControlPasteSource
  inputType?: string
  directMaxBytes?: number
  chunkMaxBytes?: number
  maxBytes?: number
  measuredByteLength?: number
  measureYieldAfterCodeUnits?: number
  yieldToEventLoop?: () => Promise<void>
  canContinue?: (target: HTMLInputElement | HTMLTextAreaElement) => boolean
  now?: () => number
}

export type TextControlPasteByteLengthMeasurement = {
  byteLength: number
  exceededLimit: boolean
}

export type TextControlPastePayloadMeasurement = TextControlPasteByteLengthMeasurement & {
  hasControlSequences?: boolean
  lineCount?: number
}
