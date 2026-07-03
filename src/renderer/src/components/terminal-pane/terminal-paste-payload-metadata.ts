import {
  countPastePayloadLines,
  getPastePayloadUtf8ByteLength,
  hasPastePayloadControlSequence,
  measurePastePayloadMetadata,
  measurePastePayloadMetadataWithYield
} from '@/lib/paste-payload-metadata'

export const measureTerminalPastePayloadMetadata = measurePastePayloadMetadata
export const measureTerminalPastePayloadMetadataWithYield = measurePastePayloadMetadataWithYield
export const utf8ByteLength = getPastePayloadUtf8ByteLength
export const countTerminalPasteLines = countPastePayloadLines
export const hasTerminalControlSequence = hasPastePayloadControlSequence
