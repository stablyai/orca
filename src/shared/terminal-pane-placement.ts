import { z } from 'zod'
import { isTerminalLeafId } from './stable-pane-id'

const NewTabPlacement = z.object({ kind: z.literal('new-tab') })

const SplitPlacement = z.object({
  kind: z.literal('split'),
  parentLeafId: z
    .string()
    .max(128)
    .refine((value): boolean => isTerminalLeafId(value)),
  direction: z.enum(['horizontal', 'vertical'])
})

// An existing tab whose layout is still empty.
const RootPlacement = z.object({ kind: z.literal('root') })

const TerminalPanePlacementSchema = z.discriminatedUnion('kind', [
  NewTabPlacement,
  SplitPlacement,
  RootPlacement
])

/** Which tab and leaf a new PTY joins; a binding reads it only for a leaf it does not know yet. */
export type TerminalPanePlacement = z.infer<typeof TerminalPanePlacementSchema>

/** Null for anything malformed, including a kind this build does not know. */
export function parseTerminalPanePlacement(value: unknown): TerminalPanePlacement | null {
  const parsed = TerminalPanePlacementSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}
