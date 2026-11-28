// A tab of a teammate's own list in a shared agent's Home, as its saved row holds it.
import { z } from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'

export const PersistedPersonTab = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('chat'), sessionId: z.string() }),
    z.object({
      kind: z.literal('terminal'),
      parentTabId: z.string(),
      leafId: z.string(),
      ptyId: z.string().nullable()
    }),
    z.object({ kind: z.literal('browser'), browserPageId: z.string() }),
    z.object({
      kind: z.literal('file'),
      relativePath: z.string(),
      filePath: z.string(),
      mode: z.enum(['edit', 'diff']),
      diffSource: z.enum(['staged', 'unstaged']).optional(),
      oldPath: z.string().optional()
    })
  ])
)
export type PersistedPersonTab = z.infer<typeof PersistedPersonTab>
export type PersistedPersonSurface = Exclude<PersistedPersonTab, { kind: 'chat' }>

/** A saved list's tabs; one that does not parse (a newer build's kind) is left out. */
export function parsePersistedPersonTabs(raw: unknown): PersistedPersonTab[] {
  return Array.isArray(raw)
    ? raw.flatMap((tab) => {
        const parsed = PersistedPersonTab.safeParse(tab)
        return parsed.success ? [parsed.data] : []
      })
    : []
}
