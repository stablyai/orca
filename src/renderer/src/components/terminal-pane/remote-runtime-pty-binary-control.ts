import {
  TerminalStreamOpcode,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  encodeTerminalStreamText
} from '../../../../shared/terminal-stream-protocol'

export type RemoteRuntimeBinarySender = (bytes: Uint8Array<ArrayBufferLike>) => void

export function sendRemoteRuntimeTerminalInputFrame(
  sendBinary: RemoteRuntimeBinarySender | null,
  streamId: number | null,
  text: string
): boolean {
  if (!sendBinary || streamId === null) {
    return false
  }
  sendBinary(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Input,
      streamId,
      seq: 0,
      payload: encodeTerminalStreamText(text)
    })
  )
  return true
}

export function sendRemoteRuntimeTerminalResizeFrame(
  sendBinary: RemoteRuntimeBinarySender | null,
  streamId: number | null,
  cols: number,
  rows: number
): boolean {
  if (!sendBinary || streamId === null) {
    return false
  }
  sendBinary(
    encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Resize,
      streamId,
      seq: 0,
      payload: encodeTerminalStreamJson({ cols, rows })
    })
  )
  return true
}
