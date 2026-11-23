import { z } from 'zod'
import { MouseButton, MouseXY } from './browser-params'
import { OptionalFiniteNumber } from '../rpc-param-primitives'

export const MouseClick = MouseXY.merge(MouseButton).extend({
  radius: OptionalFiniteNumber,
  // The phone shows a tap's file picker refusal instead of replaying the tap as a press; old hosts strip it.
  fileChooserRefusal: z.literal(1).optional()
})

// Host paths a viewer staged, dropped on the page at x, y as a file drag would.
export const DropFiles = MouseXY.extend({
  files: z.array(z.string().min(1)).min(1)
})
