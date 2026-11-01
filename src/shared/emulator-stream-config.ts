export type EmulatorStreamOrientation =
  | 'portrait'
  | 'landscape_left'
  | 'landscape_right'
  | 'portrait_upside_down'

export type EmulatorStreamConfig = {
  width: number
  height: number
  orientation?: EmulatorStreamOrientation
}
