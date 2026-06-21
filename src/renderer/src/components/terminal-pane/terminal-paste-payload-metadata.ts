import {
  PASTE_PAYLOAD_METADATA_YIELD_CODE_UNITS,
  countPastePayloadLines,
  getPastePayloadUtf8ByteLength,
  hasPastePayloadControlSequence,
  measurePastePayloadMetadata,
  measurePastePayloadMetadataWithYield,
  type PastePayloadMetadata
} from '@/lib/paste-payload-metadata'

export type TerminalPastePayloadMetadata = PastePayloadMetadata

export const TERMINAL_PASTE_METADATA_YIELD_CODE_UNITS = PASTE_PAYLOAD_METADATA_YIELD_CODE_UNITS

export const measureTerminalPastePayloadMetadata = measurePastePayloadMetadata
export const measureTerminalPastePayloadMetadataWithYield = measurePastePayloadMetadataWithYield
export const utf8ByteLength = getPastePayloadUtf8ByteLength
export const countTerminalPasteLines = countPastePayloadLines
export const hasTerminalControlSequence = hasPastePayloadControlSequence
