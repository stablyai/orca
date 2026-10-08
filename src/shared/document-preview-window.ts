import { z } from 'zod'

export const MarkdownPreviewWindowSchema = z
  .object({
    fileId: z.string().min(1).max(1024),
    title: z.string().max(1024),
    sourceGrantId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    refreshError: z.string().max(4096).nullable().optional(),
    html: z
      .string()
      .min(1)
      .max(32 * 1024 * 1024)
  })
  .strict()

export type MarkdownPreviewWindowRequest = z.infer<typeof MarkdownPreviewWindowSchema>

export const HtmlPreviewWindowSchema = z
  .object({
    grantId: z.string().regex(/^[a-f0-9]{32}$/)
  })
  .strict()

export type MarkdownPreviewWindowSource = {
  open: boolean
  content: string | null
  error: string | null
}
