import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import {
  CLIPBOARD_IMAGE_MAX_BASE64_CHARS as MAX_CLIPBOARD_IMAGE_BASE64_CHARS,
  CLIPBOARD_IMAGE_TOO_LARGE_ERROR
} from '../../clipboard/clipboard-image'

export const CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS = 512 * 1024

export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export function isValidBase64(value: string): boolean {
  return value.length % 4 !== 1 && BASE64_PATTERN.test(value)
}

export function clipboardImageBase64Payload(maxChars: number, tooLargeMessage: string) {
  return z.unknown().transform((value, ctx): string => {
    if (typeof value !== 'string') {
      ctx.addIssue({ code: 'custom', message: 'Missing image content' })
      return z.NEVER
    }
    if (value.length > maxChars) {
      ctx.addIssue({ code: 'custom', message: tooLargeMessage })
      return z.NEVER
    }
    if (!isValidBase64(value)) {
      ctx.addIssue({ code: 'custom', message: 'Clipboard image content must be base64' })
      return z.NEVER
    }
    return value
  })
}

export const SaveImageAsTempFile = lazyZodSchema(() =>
  z.object({
    contentBase64: clipboardImageBase64Payload(
      MAX_CLIPBOARD_IMAGE_BASE64_CHARS,
      CLIPBOARD_IMAGE_TOO_LARGE_ERROR
    ),
    connectionId: z.string().min(1).nullable().optional()
  })
)

export const StartImageUpload = lazyZodSchema(() =>
  z.object({
    expectedBase64Length: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_CLIPBOARD_IMAGE_BASE64_CHARS, CLIPBOARD_IMAGE_TOO_LARGE_ERROR),
    connectionId: z.string().min(1).nullable().optional(),
    // Older hosts drop this unknown key and keep naming the upload .png.
    fileName: z.string().min(1).max(1024).optional()
  })
)

export const AppendImageUploadChunk = lazyZodSchema(() =>
  z.object({
    uploadId: z.string().min(1),
    offset: z.number().int().nonnegative(),
    contentBase64: clipboardImageBase64Payload(
      CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
      'Clipboard image chunk is too large'
    )
  })
)

export const CommitImageUpload = lazyZodSchema(() =>
  z.object({
    uploadId: z.string().min(1)
  })
)

export const AbortImageUpload = lazyZodSchema(() =>
  z.object({
    uploadId: z.string().min(1)
  })
)
