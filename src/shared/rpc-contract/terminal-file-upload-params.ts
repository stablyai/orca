import { z } from 'zod'
import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS,
  AGENT_SESSION_ATTACHMENT_MAX_BYTES
} from '../agent-session/agent-session-attachments'
import { isValidBase64 } from './clipboard-params'
import { Identifier } from './structured-agent-session-params'

const UploadId = Identifier('Invalid upload id', 128)

export const TerminalFileUploadStartParams = z
  .object({
    name: z.string().min(1).max(1024),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(AGENT_SESSION_ATTACHMENT_MAX_BYTES, 'File is too large'),
    connectionId: z.string().min(1).nullable().optional()
  })
  .strict()

export const TerminalFileUploadAppendParams = z
  .object({
    uploadId: UploadId,
    offset: z.number().int().nonnegative(),
    contentBase64: z
      .string()
      .max(AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS, 'File chunk is too large')
      .refine(isValidBase64, 'File chunk must be base64')
  })
  .strict()

export const TerminalFileUploadIdParams = z.object({ uploadId: UploadId }).strict()
