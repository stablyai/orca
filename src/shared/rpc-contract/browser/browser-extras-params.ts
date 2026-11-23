import { z } from 'zod'
import { MouseButton, MouseXY } from './browser-params'
import { OptionalFiniteNumber } from '../rpc-param-primitives'

export const MouseClick = MouseXY.merge(MouseButton).extend({
  radius: OptionalFiniteNumber,
  // The phone shows a tap's file picker refusal instead of replaying the tap as a press; old hosts strip it.
  fileChooserRefusal: z.literal(1).optional()
})
