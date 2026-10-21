// `layout.apply`'s batch of generated tab titles (see LayoutApplyParams).
import { z } from 'zod'

/** Agent-generated titles for many tabs, of any workspaces: main renames them in one write. */
export const RenameTabsCommand = z.object({
  type: z.literal('renameTabs'),
  kind: z.literal('generated'),
  renames: z
    .array(
      z.object({
        workspace: z.string().min(1),
        tabId: z.string().min(1),
        title: z.union([z.string(), z.null()]),
        replaceExisting: z.literal(true).optional()
      })
    )
    .min(1)
})
