import { z } from 'zod'
import { FileOpen, WorktreeSelector } from './files-target-params'

export const RUNTIME_FILE_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function isValidRuntimeFileBase64(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length % 4 !== 1 && RUNTIME_FILE_BASE64_PATTERN.test(value)
  )
}

export const FileMutationOpen = FileOpen.extend({
  expectedExecutionHostId: z.string().min(1).optional(),
  expectedSshTargetId: z.string().min(1).optional(),
  expectedSshConnectionGeneration: z.number().int().nonnegative().optional()
})

// Why: write content must be a real string. Coercing a missing/non-string value
// to '' silently truncated the target file to empty instead of erroring. An
// explicit '' is still accepted (writing an empty file is legitimate).
export const FileWrite = FileMutationOpen.extend({
  content: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
})

export const FileWriteBase64 = FileMutationOpen.extend({
  contentBase64: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
    // Why: Buffer.from(..., 'base64') accepts malformed input by dropping
    // invalid bytes, which can silently create empty or corrupt uploaded files.
    .refine(isValidRuntimeFileBase64, 'File content must be base64')
})

export const FileWriteBase64Chunk = FileWriteBase64.extend({
  append: z.boolean().optional()
})

export const FileRename = WorktreeSelector.extend({
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

export const FileCopy = WorktreeSelector.extend({
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

export const FileCommitUpload = WorktreeSelector.extend({
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

export const FileDelete = FileMutationOpen.extend({
  recursive: z.boolean().optional()
})
