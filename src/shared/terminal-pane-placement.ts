import { z } from 'zod'
import { isTerminalLeafId } from './stable-pane-id'
import { terminalPaneLayoutNodeSchema, terminalTabSchema } from './workspace-session-schema'

// The creation fields of the tab the renderer made, so main need not wait for its save.
const NewTabRow = terminalTabSchema
  .pick({
    title: true,
    defaultTitle: true,
    customTitle: true,
    color: true,
    createdAt: true,
    startupCwd: true,
    quickCommandLabel: true,
    launchAgent: true,
    viewMode: true
  })
  .extend({ shellOverride: z.string().optional() })
  .partial()

// Optional fields degrade alone: a malformed one is dropped, not the whole placement.
const NewTabPlacement = z.object({
  kind: z.literal('new-tab'),
  row: NewTabRow.optional().catch(undefined)
})

const SplitPlacement = z.object({
  kind: z.literal('split'),
  parentLeafId: z
    .string()
    .max(128)
    .refine((value): boolean => isTerminalLeafId(value)),
  direction: z.enum(['horizontal', 'vertical']),
  ratio: z.number().optional().catch(undefined),
  /** The tab's tree after the split, which `parentLeafId` alone can't express (subtrees, before/after). */
  proposedRoot: terminalPaneLayoutNodeSchema.optional().catch(undefined)
})

// An existing tab whose layout is still empty.
const RootPlacement = z.object({ kind: z.literal('root') })

const TerminalPanePlacementSchema = z.discriminatedUnion('kind', [
  NewTabPlacement,
  SplitPlacement,
  RootPlacement
])

export type TerminalPaneNewTabRow = z.infer<typeof NewTabRow>

/** Which tab and leaf a new PTY joins; a binding reads it only for a leaf it does not know yet. */
export type TerminalPanePlacement = z.infer<typeof TerminalPanePlacementSchema>

/** Null for anything malformed, including a kind this build does not know. */
export function parseTerminalPanePlacement(value: unknown): TerminalPanePlacement | null {
  const parsed = TerminalPanePlacementSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
