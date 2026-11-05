import { z } from 'zod'
import type { LocalFileAccess } from './local-file-access'
import { MAX_FILE_RANGE_READ_BYTES } from './file-range-read'

export const RANGED_FILE_DOCUMENT_CAPABILITY = 'files.rangeDocument.v1' as const
export const RANGED_FILE_DOCUMENT_MAX_BYTES = 1024 * 1024 * 1024
export const RANGED_FILE_DOCUMENT_METHODS = {
  open: 'files.rangeDocumentOpen',
  read: 'files.rangeDocumentRead',
  reload: 'files.rangeDocumentReload',
  close: 'files.rangeDocumentClose',
  cancel: 'files.rangeDocumentCancel',
  status: 'files.rangeDocumentStatus'
} as const

export const RANGED_FILE_DOCUMENT_ERROR_CODES = [
  'range_document_busy',
  'range_document_cancelled',
  'range_document_changed',
  'range_document_stale',
  'range_document_invalid_range',
  'range_document_invalid_request',
  'range_document_unknown',
  'range_document_too_large',
  'range_document_unsupported'
] as const
export class RangedFileDocumentError extends Error {
  constructor(
    readonly code: (typeof RANGED_FILE_DOCUMENT_ERROR_CODES)[number],
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code)
    this.name = 'RangedFileDocumentError'
  }
}

export function isRangedFileDocumentMethod(method: string): boolean {
  return Object.values(RANGED_FILE_DOCUMENT_METHODS).some((value) => value === method)
}

export type RangedFileDocumentDescriptor = {
  id: string
  version: number
  byteLength: number
  maxReadBytes: number
  readOnly: true
  isBinary: boolean
  valid: boolean
}
export type RangedFileDocumentRead = {
  id: string
  version: number
  offset: number
  length: number
  requestToken: string
}
export type RangedFileDocumentChunk = {
  version: number
  contentBase64: string
  bytesRead: number
  eof: boolean
}
export type RangedFileDocumentLocalOpen = {
  filePath: string
  connectionId?: string
  access?: LocalFileAccess
  wakeWslDistro?: boolean
}

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const RangedDocumentId = z.strictObject({ id: z.string().uuid() })
export const RangedDocumentOpen = z.strictObject({
  worktree: z.string().min(1),
  relativePath: z.string().min(1)
})
export const RangedDocumentRead = RangedDocumentId.extend({
  version: safeInteger,
  offset: safeInteger,
  length: safeInteger.min(1).max(MAX_FILE_RANGE_READ_BYTES),
  requestToken: z.string().min(1).max(128)
})
export const RangedDocumentCancel = RangedDocumentId.extend({
  requestToken: z.string().min(1).max(128)
})
