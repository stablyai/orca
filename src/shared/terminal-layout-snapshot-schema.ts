import { z } from 'zod'
import type { TerminalPaneLayoutNode } from './terminal-tab-types'
import { salvagedOptional, salvagingRecord } from './zod-salvage'

const terminalPaneSplitDirectionSchema = z.enum(['vertical', 'horizontal'])

// Lazy annotated recursion avoids eager inference; discriminated dispatch avoids retrying leaf parsing at every split.
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
