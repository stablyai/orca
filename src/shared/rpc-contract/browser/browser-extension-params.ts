import { z } from 'zod'
import { isChromeExtensionId } from '../../browser/extensions/browser-extension-url'

export const ExtensionList = z.object({ profileId: z.string().min(1).optional() })
export const ExtensionReload = z
  .object({
    extensionId: z.string().refine(isChromeExtensionId, 'Invalid Chrome extension ID').optional(),
    path: z.string().min(1).optional()
  })
  .refine(({ extensionId, path }) => (extensionId === undefined) !== (path === undefined), {
    message: 'Pass either an extension ID or --path <folder>'
  })
