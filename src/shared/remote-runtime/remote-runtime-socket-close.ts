import type WebSocket from 'ws'

export function closeRemoteRuntimeSocket(socket: WebSocket | null): void {
  try {
    socket?.close()
  } catch {
    // Socket teardown is best effort after request ownership has been released.
  }
}
