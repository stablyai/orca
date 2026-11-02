import { z } from 'zod'
import { STAGED_FILE_SAVE_LIMITS } from '../staged-file-save'
import {
  FileMutationOpen,
  FileWriteDiskPreconditionParam,
  isValidRuntimeFileBase64
} from './files-mutation-params'

const SaveId = z.string().uuid()

export const FileSaveBegin = FileMutationOpen.extend({
  totalBytes: z.number().int().nonnegative().max(STAGED_FILE_SAVE_LIMITS.maxBytesPerSave)
})

export const FileSaveChunk = z.object({
  saveId: SaveId,
  offset: z.number().int().nonnegative(),
  contentBase64: z
    .unknown()
    .refine((v): v is string => typeof v === 'string', { message: 'Missing file content' })
    .refine(isValidRuntimeFileBase64, 'File content must be base64')
})

export const FileSaveCommit = z.object({
  saveId: SaveId,
  diskPrecondition: FileWriteDiskPreconditionParam.optional()
})

export const FileSaveAbort = z.object({ saveId: SaveId })
