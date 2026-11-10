import { z } from 'zod'
import { isDocPreviewUrl } from '../../document-preview/doc-preview-scheme'

const browserPageInventoryEntrySchema = z.strictObject({
  browserPageId: z.string().min(1),
  browserWorkspaceId: z.string().min(1),
  title: z.string(),
  url: z.string().refine((url) => !isDocPreviewUrl(url)),
  profileId: z.string().min(1).nullable(),
  loadError: z
    .strictObject({ code: z.number(), description: z.string(), validatedUrl: z.string() })
    .nullable(),
  certificateFailure: z
    .strictObject({
      challengeId: z.string(),
      browserPageId: z.string(),
      errorCode: z.number().nullable(),
      error: z.string(),
      origin: z.string(),
      displayHost: z.string(),
      canProceed: z.boolean(),
      observedAt: z.number()
    })
    .nullable()
})

export type BrowserPageInventoryEntry = z.infer<typeof browserPageInventoryEntrySchema>

/** A supplied array is a complete inventory; malformed or duplicate rows must not silently close pages. */
export const browserPageInventorySchema = z
  .array(browserPageInventoryEntrySchema)
  .refine((pages) => new Set(pages.map((page) => page.browserPageId)).size === pages.length)
