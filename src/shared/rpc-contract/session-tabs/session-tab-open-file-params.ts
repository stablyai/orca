// A file a teammate opens as a tab of their own list in a shared agent's Home.
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { WorktreeTabSelector } from './session-tabs-schemas-params'

export const OpenFileTab = lazyZodSchema(() =>
  WorktreeTabSelector.extend({
    relativePath: z.string().min(1).max(4096),
    /** `diff` shows its working-tree (or `staged`) change against `oldPath`, else the same path. */
    mode: z.enum(['edit', 'diff']).optional(),
    staged: z.boolean().optional(),
    oldPath: z.string().min(1).max(4096).optional(),
    activate: z.boolean().optional()
  })
)
