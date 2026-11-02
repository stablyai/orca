export type EmulatorVideoStreamStartArgs = {
  deviceId: string
  streamId: string
  avccStreamUrl?: string
}

export type EmulatorVideoStreamFrameMessage = {
  streamId: string
  deviceId: string
  config: boolean
  keyFrame: boolean
  seed?: boolean
  bytes: ArrayBuffer
}

export type EmulatorVideoStreamMetaMessage = {
  streamId: string
  deviceId: string
  meta: { codecId: string; width: number; height: number }
}

export type EmulatorVideoStreamErrorMessage = {
  streamId: string
  deviceId: string
  message: string
}

export type EmulatorVideoApi = {
  startVideoStream: (args: EmulatorVideoStreamStartArgs) => Promise<{ streamId: string }>
  stopVideoStream: (args: { streamId: string }) => Promise<void>
  onVideoStreamMeta: (callback: (data: EmulatorVideoStreamMetaMessage) => void) => () => void
  onVideoStreamFrame: (callback: (data: EmulatorVideoStreamFrameMessage) => void) => () => void
  onVideoStreamError?: (callback: (data: EmulatorVideoStreamErrorMessage) => void) => () => void
}
