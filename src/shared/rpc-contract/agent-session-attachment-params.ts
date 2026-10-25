import { z } from 'zod'
import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS,
  AGENT_SESSION_ATTACHMENT_MAX_BYTES
} from '../agent-session-attachments'
import { isValidBase64 } from './clipboard-params'
import { Identifier, SessionId } from './structured-agent-session-params'

const UploadId = Identifier('Invalid upload id', 128)

export const AttachmentUploadStartParams = z
  .object({
    sessionId: SessionId,
    name: z.string().min(1).max(1024),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(AGENT_SESSION_ATTACHMENT_MAX_BYTES, 'Attachment is too large')
  })
  .strict()

export const AttachmentUploadAppendParams = z
  .object({
    uploadId: UploadId,
    offset: z.number().int().nonnegative(),
    contentBase64: z
      .string()
      .max(AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS, 'Attachment chunk is too large')
      .refine(isValidBase64, 'Attachment chunk must be base64')
  })
  .strict()

export const AttachmentUploadIdParams = z.object({ uploadId: UploadId }).strict()

export const AttachmentReadParams = z.object({ path: z.string().min(1).max(4096) }).strict()
