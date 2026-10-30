import { z } from 'zod'
import { TerminalPaneLayoutNodeSchema } from './session-tabs-schemas-params'
import { TerminalOrphanGroupLayout } from './terminal-orphan-params'

/** Divider ratios, each the split it moved by path from the root ("first.second"; "" the root). */
const SplitRatioIntents = z
  .array(
    z.object({
      path: z.string().regex(/^((first|second)(\.(first|second))*)?$/),
      ratio: z.number().gt(0).lt(1),
      // The split the window means: its direction and the first pane or group on each side.
      split: z
        .object({
          direction: z.enum(['horizontal', 'vertical']),
          first: z.string().min(1),
          second: z.string().min(1)
        })
        .optional()
    })
  )
  .min(1)

/** Use ratios, or legacy root trees; main refuses either if pane identities differ. */
export const SetPaneRatiosCommand = z
  .object({
    type: z.literal('setPaneRatios'),
    workspace: z.string().min(1),
    tabId: z.string().min(1),
    root: TerminalPaneLayoutNodeSchema.optional(),
    ratios: SplitRatioIntents.optional()
  })
  .refine((command) => (command.root === undefined) !== (command.ratios === undefined))

/** As SetPaneRatiosCommand, for the workspace's group splits (`groupLayout`: the older form). */
export const SetGroupRatiosCommand = z
  .object({
    type: z.literal('setGroupRatios'),
    workspace: z.string().min(1),
    groupLayout: TerminalOrphanGroupLayout.optional(),
    ratios: SplitRatioIntents.optional()
  })
  .refine((command) => (command.groupLayout === undefined) !== (command.ratios === undefined))
