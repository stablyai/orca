import { z } from 'zod'
import { salvagedOptional, salvagingArray, salvagingRecord } from './zod-salvage'

/** Bounds of a detached pane's OS window, as persisted in the workspace session. */
const auxWindowBoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

/**
 * Session fields describing detached panes. Both are optional: a session
 * written before this feature simply hydrates as "nothing detached".
 */
export const detachedPaneSessionFields = {
  detachedGroupIds: salvagedOptional('detachedGroupIds', salvagingArray(z.string())),
  auxWindowBoundsByGroupId: salvagedOptional(
    'auxWindowBoundsByGroupId',
    salvagingRecord(z.string(), auxWindowBoundsSchema)
  )
}
