import { z } from 'zod'
import { FileTreePath } from './files-params'

/** Uncompressed bytes one folder archive may hold; ZIP without ZIP64 tops out at 4 GiB. */
export const FOLDER_ARCHIVE_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
/** Entries one folder archive may hold; a ZIP without ZIP64 counts entries in 16 bits. */
export const FOLDER_ARCHIVE_MAX_ENTRIES = 65_000
/** Largest archive page one read returns; base64 keeps the reply well under the 4 MiB frame budget. */
export const FOLDER_ARCHIVE_MAX_READ_BYTES = 2 * 1024 * 1024
/** Directory names skipped when the caller asks to leave out dependency and VCS folders. */
export const FOLDER_ARCHIVE_DEFAULT_EXCLUDED_NAMES = ['node_modules', '.git'] as const

export const FileArchiveStart = FileTreePath.extend({
  /** Skip FOLDER_ARCHIVE_DEFAULT_EXCLUDED_NAMES at any depth. */
  excludeDefaultDirs: z.boolean().optional()
})

export const FileArchiveRead = z.object({
  archiveId: z.string().min(1).max(128),
  maxBytes: z.number().int().positive().max(FOLDER_ARCHIVE_MAX_READ_BYTES)
})

export const FileArchiveCancel = z.object({
  archiveId: z.string().min(1).max(128)
})

export type FileArchiveStartResult = {
  archiveId: string
  /** Archive name the host suggests, e.g. `src.zip`. */
  suggestedName: string
  fileCount: number
  directoryCount: number
  /** Sum of the regular files' sizes at walk time. */
  totalBytes: number
  /** Directories left out by `excludeDefaultDirs`. */
  excludedDirCount: number
}

export type FileArchiveReadResult = {
  contentBase64: string
  bytesRead: number
  eof: boolean
  /** Uncompressed file bytes archived so far; compare with `totalBytes` for progress. */
  processedBytes: number
  /** Entries skipped because they vanished or became unreadable mid-archive. */
  skippedCount: number
}

export type FileArchiveErrorCode =
  | 'archive_not_directory'
  | 'archive_too_large'
  | 'archive_too_many_entries'
  | 'archive_not_found'
  | 'archive_busy'
