import type { z } from 'zod'
import type { RotateOrientation } from './rpc-contract/emulator-params'

export type EmulatorControlStreamStatus = {
  streamId: string
  connected: boolean
  pressedKeyboardUsages?: number[]
  orientation?: z.infer<typeof RotateOrientation>
}

export type EmulatorControlApi = {
  startControlStream: (args: {
    streamId: string
    wsUrl: string
    pressedKeyboardUsages?: number[]
  }) => Promise<void>
  sendControlFrame: (args: { streamId: string; bytes: Uint8Array<ArrayBuffer> }) => void
  stopControlStream: (args: { streamId: string }) => void
  onControlStreamStatus: (callback: (status: EmulatorControlStreamStatus) => void) => () => void
}
