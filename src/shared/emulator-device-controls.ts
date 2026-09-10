export type EmulatorPosture = 'folded' | 'unfolded'

export type EmulatorButtonOptions = {
  longPress?: boolean
}

export type EmulatorDeviceControlCapabilities = {
  shutdown: boolean
  power: boolean
  volume: boolean
  overview: boolean
  foldable: boolean
  wearButton1: boolean
  wearButton2: boolean
}
