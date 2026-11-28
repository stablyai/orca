import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { isChromeExtensionId } from '../../browser/extensions/browser-extension-url'

export const ExtensionList = lazyZodSchema(() =>
  z.object({ profileId: z.string().min(1).optional() })
)
export const ExtensionReload = lazyZodSchema(() =>
  z
    .object({
      extensionId: z.string().refine(isChromeExtensionId, 'Invalid Chrome extension ID').optional(),
      path: z.string().min(1).optional()
    })
    .refine(({ extensionId, path }) => (extensionId === undefined) !== (path === undefined), {
      message: 'Pass either an extension ID or --path <folder>'
    })
)
