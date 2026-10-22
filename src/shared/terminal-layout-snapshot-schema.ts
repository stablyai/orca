// The stored terminal pane layout of one tab: its pane tree and per-pane records.

import { z } from 'zod'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'
import { salvagedOptional, salvagingRecord } from './zod-salvage'

// ─── Terminal pane layout (recursive) ───────────────────────────────

const terminalPaneSplitDirectionSchema = z.enum(['vertical', 'horizontal'])

// Why: z.lazy + type annotation keeps the recursive inference working without
// forcing zod to resolve the whole tree at definition time. Discriminated on `type` because a
// plain union re-tries the leaf branch for every split node of every restored terminal layout.
export const terminalPaneLayoutNodeSchema: z.ZodType<TerminalPaneLayoutNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('leaf'),
      leafId: z.string()
    }),
    z.object({
      type: z.literal('split'),
      direction: terminalPaneSplitDirectionSchema,
      first: terminalPaneLayoutNodeSchema,
      second: terminalPaneLayoutNodeSchema,
      ratio: z.number().optional()
    })
  ])
)

export const leafStringsSchema = salvagingRecord(z.string(), z.string())

const terminalGridSchema = z.object({
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
})

export const terminalLayoutSnapshotSchema = z.object({
  root: terminalPaneLayoutNodeSchema.nullable(),
  activeLeafId: z.string().nullable(),
  expandedLeafId: z.string().nullable(),
  chatLeafId: z.string().optional(),
  ptyIdsByLeafId: salvagedOptional('ptyIdsByLeafId', leafStringsSchema),
  buffersByLeafId: salvagedOptional('buffersByLeafId', leafStringsSchema),
  scrollbackRefsByLeafId: salvagedOptional('scrollbackRefsByLeafId', leafStringsSchema),
  titlesByLeafId: salvagedOptional('titlesByLeafId', leafStringsSchema),
  lastGridsByLeafId: salvagedOptional(
    'lastGridsByLeafId',
    salvagingRecord(z.string(), terminalGridSchema)
  )
})
