export type NativeVideoFrame = {
  width: number
  height: number
  rotation: number
  sequence: number
  timestampUs: string
  pixels: Uint8Array
  droppedFrames?: number
}
export type NativeVideoRequest = {
  deviceId: string
  streamId: string
  width: number
  height: number
}

export type NativeVideoViewer = {
  width: number
  height: number
  frame: (frame: NativeVideoFrame) => void
  end: () => void
}
