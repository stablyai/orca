import { z } from 'zod'

/** Immutable, non-derivable parts of a reservation-bearing worktree create response. */
export const WorktreeReservationCreateReceiptSchema = z
  .object({
    version: z.literal(1),
    warnings: z.array(
      z.object({
        code: z.enum([
          'LINEAGE_PARENT_CONTEXT_MISSING',
          'LINEAGE_PARENT_CONTEXT_CONFLICT',
          'LINEAGE_PARENT_INSTANCE_STALE'
        ]),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).optional()
      })
    ),
    warning: z.string().optional(),
    startupTerminal: z
      .object({
        spawned: z.boolean(),
        handle: z.string().min(1).optional(),
        tabId: z.string().min(1).optional(),
        paneKey: z.string().min(1).nullable().optional(),
        ptyId: z.string().min(1).nullable().optional(),
        surface: z.enum(['visible', 'background']).optional()
      })
      .optional(),
    agentTerminalHandle: z.string().min(1).optional()
  })
  .superRefine((receipt, context) => {
    if (
      receipt.agentTerminalHandle !== undefined &&
      receipt.agentTerminalHandle !== receipt.startupTerminal?.handle
    ) {
      context.addIssue({
        code: 'custom',
        path: ['agentTerminalHandle'],
        message: 'agentTerminalHandle must match startupTerminal.handle'
      })
    }
  })

export type WorktreeReservationCreateReceipt = z.infer<
  typeof WorktreeReservationCreateReceiptSchema
>
