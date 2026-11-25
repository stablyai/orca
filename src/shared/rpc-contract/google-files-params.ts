import * as z from 'zod'
import {
  PAIRED_REQUEST_PARAMS_MAX_BYTES,
  pairedRequestFileBudget
} from '../remote-runtime/paired-request-budget'
import { GoogleCallParams as Call, GoogleRef as Ref } from './google-call-params'

const PageToken = z.string().min(1).max(2_048).optional()
const Offset = z.number().int().nonnegative().optional()
const Name = z.string().trim().min(1).max(1_024)
// Text and cells ride in one request, which the CLI keeps under PAIRED_REQUEST_PARAMS_MAX_BYTES.
const Markdown = z.string().max(PAIRED_REQUEST_PARAMS_MAX_BYTES)
// A file rides in one request as base64, beside its name and folder.
export const DRIVE_UPLOAD_MAX_BYTES = pairedRequestFileBudget(4 * 1024)
const Cell = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null()])
const Rows = z.array(z.array(Cell).max(1_000)).min(1).max(20_000)
const Tab = z.string().trim().min(1).max(200).optional()
const A1 = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z]{0,3}\d*(:[A-Za-z]{0,3}\d*)?$/,
    'Give the range as A1:F50, and the tab with --tab.'
  )
  .refine((range) => /[A-Za-z\d]/.test(range), 'Give the range as A1:F50.')

export const DriveSearchParams = z.object({
  ...Call,
  query: z.string().trim().max(500).optional(),
  in: Ref.optional(),
  pageToken: PageToken,
  limit: z.number().int().min(1).max(50).optional()
})
export const DriveListParams = z.object({
  ...Call,
  folder: Ref,
  pageToken: PageToken,
  limit: z.number().int().min(1).max(50).optional()
})
export const DriveReadParams = z.object({ ...Call, ref: Ref, offset: Offset })
export const DriveDownloadParams = z.object({ ...Call, ref: Ref })
export const DriveUploadParams = z.object({
  ...Call,
  name: Name,
  data: z.string().max(PAIRED_REQUEST_PARAMS_MAX_BYTES),
  folder: Ref.optional(),
  convert: z.boolean().optional()
})
export const DriveMkdirParams = z.object({ ...Call, name: Name, in: Ref.optional() })
export const DriveMoveParams = z.object({ ...Call, ref: Ref, folder: Ref })
export const DriveShareParams = z.object({
  ...Call,
  ref: Ref,
  with: z.array(z.string().trim().toLowerCase().email().max(320)).min(1).max(50),
  role: z.enum(['reader', 'commenter', 'writer']),
  notify: z.boolean().optional()
})

export const DocsReadParams = z.object({ ...Call, ref: Ref, offset: Offset })
export const DocsCreateParams = z.object({
  ...Call,
  title: Name,
  markdown: Markdown,
  folder: Ref.optional()
})
export const DocsAppendParams = z.object({
  ...Call,
  ref: Ref,
  markdown: Markdown.min(1, 'Give the text to add with --body or --body-file.')
})
export const DocsReplaceParams = z.object({
  ...Call,
  ref: Ref,
  pairs: z
    .array(z.object({ old: z.string().min(1).max(10_000), new: z.string().max(10_000) }))
    .min(1)
    .max(500),
  suggest: z.boolean().optional(),
  all: z.boolean().optional(),
  matchCase: z.boolean().optional()
})
export const DocsCommentParams = z.object({
  ...Call,
  ref: Ref,
  // Google keeps 2,048; the rest is room for an "asked by" line (at most 140, after a blank line).
  text: z.string().trim().min(1, 'Give the comment with --body or --body-file.').max(1_900),
  on: z.string().min(1).max(10_000).optional()
})

export const SheetsCreateParams = z.object({ ...Call, title: Name })
export const SheetsReadParams = z.object({ ...Call, ref: Ref, tab: Tab, range: A1.optional() })
const Values = { ref: Ref, tab: Tab, values: Rows, formulas: z.boolean().optional() }
export const SheetsWriteParams = z.object({ ...Call, ...Values, range: A1 })
export const SheetsAppendParams = z.object({ ...Call, ...Values })
export const SheetsUpsertParams = z.object({
  ...Call,
  ...Values,
  key: z.string().trim().min(1).max(200)
})
