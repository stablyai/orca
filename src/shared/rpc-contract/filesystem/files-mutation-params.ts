import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { FileOpen, WorktreeSelector } from './files-target-params'

export const RUNTIME_FILE_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function isValidRuntimeFileBase64(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length % 4 !== 1 &&
    (!value.includes('=') || value.length % 4 === 0) &&
    RUNTIME_FILE_BASE64_PATTERN.test(value)
  )
}

export const FileMutationOpen = lazyZodSchema(() =>
  FileOpen.extend({
    expectedExecutionHostId: z.string().min(1).optional(),
    expectedSshTargetId: z.string().min(1).optional(),
    expectedSshConnectionGeneration: z.number().int().nonnegative().optional()
  })
)

// Reject missing/non-string content instead of coercing to empty and truncating the file; explicit empty remains valid.
export const FileWrite = lazyZodSchema(() =>
  FileMutationOpen.extend({
    content: z
      .unknown()
      .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
  })
)

export const FileFormatText = lazyZodSchema(() =>
  FileMutationOpen.extend({
    content: z.string().max(2 * 1024 * 1024)
  })
)

// Why a separate method: a host too old to honor the precondition answers method_not_found
// instead of silently dropping the field and writing over newer disk content.
export const FileWriteDiskPreconditionParam = lazyZodSchema(() =>
  z.object({
    expectedSignature: z.string().min(1).max(64),
    allowMissing: z.boolean().optional(),
    requireLosslessUtf8: z.boolean().optional()
  })
)

export const FileWriteIfUnchanged = lazyZodSchema(() =>
  FileWrite.extend({
    diskPrecondition: FileWriteDiskPreconditionParam
  })
)

export const FileWriteBase64 = lazyZodSchema(() =>
  FileMutationOpen.extend({
    contentBase64: z
      .unknown()
      .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
      // Buffer.from tolerates malformed base64 and may silently create empty or corrupt files.
      .refine(isValidRuntimeFileBase64, 'File content must be base64')
  })
)

export const FileWriteBase64Chunk = lazyZodSchema(() =>
  FileWriteBase64.extend({
    append: z.boolean().optional()
  })
)

export const FileRename = lazyZodSchema(() =>
  WorktreeSelector.extend({
    expectedExecutionHostId: z.string().min(1).optional(),
    expectedSshTargetId: z.string().min(1).optional(),
    expectedSshConnectionGeneration: z.number().int().nonnegative().optional(),
    oldRelativePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing source path')),
    newRelativePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing destination path'))
  })
)

export const FileCopy = lazyZodSchema(() =>
  WorktreeSelector.extend({
    expectedExecutionHostId: z.string().min(1).optional(),
    expectedSshTargetId: z.string().min(1).optional(),
    expectedSshConnectionGeneration: z.number().int().nonnegative().optional(),
    sourceRelativePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing source path')),
    destinationRelativePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing destination path'))
  })
)

export const FileCommitUpload = lazyZodSchema(() =>
  WorktreeSelector.extend({
    expectedExecutionHostId: z.string().min(1).optional(),
    expectedSshTargetId: z.string().min(1).optional(),
    expectedSshConnectionGeneration: z.number().int().nonnegative().optional(),
    tempRelativePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing temporary path')),
    finalRelativePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing final path'))
  })
)

export const FileReplaceWithUpload = lazyZodSchema(() =>
  FileCommitUpload.extend({
    bytesPrecondition: z.object({
      expectedSha256: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
      allowMissing: z.boolean().optional()
    })
  })
)

export const FileDelete = lazyZodSchema(() =>
  FileMutationOpen.extend({
    recursive: z.boolean().optional()
  })
)
