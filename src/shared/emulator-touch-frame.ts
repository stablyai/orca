export type ServeSimTouchType = 'begin' | 'move' | 'end'

export type ServeSimTouchFrame = {
  type: ServeSimTouchType
  x: number
  y: number
  edge?: number
}

export const SERVE_SIM_TOUCH_MESSAGE_TAG = 0x03

export function encodeServeSimTouchFrame(touch: ServeSimTouchFrame): Uint8Array<ArrayBuffer> {
  const json = new TextEncoder().encode(JSON.stringify(touch))
  const frame = new Uint8Array(1 + json.length)
  frame[0] = SERVE_SIM_TOUCH_MESSAGE_TAG
  frame.set(json, 1)
  return frame
}
