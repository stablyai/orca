import { MouseButton, MouseXY } from './browser-params'
import { OptionalFiniteNumber } from '../rpc-param-primitives'

export const MouseClick = MouseXY.merge(MouseButton).extend({
  radius: OptionalFiniteNumber
})
