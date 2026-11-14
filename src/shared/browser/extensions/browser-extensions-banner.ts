import { z } from 'zod'

export const browserExtensionsBannerSchema = z.enum([
  'none',
  'plain_bring',
  'colored_bring',
  'plain_everyday',
  'colored_everyday'
])
export type BrowserExtensionsBanner = z.infer<typeof browserExtensionsBannerSchema>
export type BrowserExtensionsBannerLook = Exclude<BrowserExtensionsBanner, 'none'>

export const browserExtensionsBannerAssignmentSchema = z.object({
  banner: browserExtensionsBannerSchema,
  assignedAt: z.number().int().positive(),
  hadExtensions: z.boolean(),
  /** Set once the assignment event was accepted; only then does the banner follow it. */
  reported: z.boolean().optional()
})
export type BrowserExtensionsBannerAssignment = z.infer<
  typeof browserExtensionsBannerAssignmentSchema
>

export type BrowserExtensionsBannerAssignmentReply =
  | { status: 'active'; banner: BrowserExtensionsBanner }
  /** No assignment applies here; the banner uses its default look. */
  | { status: 'not_enrolled' }
  /** Nothing was written; a later request is evaluated afresh. */
  | { status: 'not_ready' }
  /** Held until the next launch. */
  | { status: 'deferred' }

/** The banner an install follows, or undefined while none is in effect. */
export function activeBrowserExtensionsBanner(
  saved: BrowserExtensionsBannerAssignment | undefined
): BrowserExtensionsBanner | undefined {
  if (saved?.reported !== true) {
    return undefined
  }
  // Why checked here: settings arrive unparsed in windows, and an unknown value must not pick a look.
  return browserExtensionsBannerSchema.options.includes(saved.banner) ? saved.banner : undefined
}

export function browserExtensionsBannerStyle(look: BrowserExtensionsBannerLook): {
  coloredIcons: boolean
  copy: 'bring' | 'everyday'
} {
  return {
    coloredIcons: look === 'colored_bring' || look === 'colored_everyday',
    copy: look === 'plain_everyday' || look === 'colored_everyday' ? 'everyday' : 'bring'
  }
}

export const BROWSER_EXTENSIONS_WEB_STORE_SOURCES = ['banner', 'toolbar_menu', 'settings'] as const
export type BrowserExtensionsWebStoreSource = (typeof BROWSER_EXTENSIONS_WEB_STORE_SOURCES)[number]

export const browserExtensionsEventSchemas = {
  browser_extensions_banner_assigned: z
    .object({ banner: browserExtensionsBannerSchema, had_extensions: z.boolean() })
    .strict(),
  browser_extensions_banner_action: z
    .object({ action: z.enum(['open_web_store', 'got_it', 'close']) })
    .strict(),
  browser_extensions_web_store_opened: z
    .object({ source: z.enum(BROWSER_EXTENSIONS_WEB_STORE_SOURCES) })
    .strict(),
  browser_extension_installed: z.object({ source: z.enum(['web_store', 'unpacked']) }).strict(),
  browser_extension_used: z.object({}).strict()
}
