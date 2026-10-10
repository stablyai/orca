/** Adapter-owned buffering and half-close lifecycle; protocol state stays in the client. */
export type BrowserNetworkTunnelClientSocket = {
  destroyed: boolean
  // False pauses delivery until requestRead; acceptance alone never replenishes credit.
  pushBytes: (bytes: Uint8Array<ArrayBufferLike> | null) => boolean
  // Fires once after the consumer drains all input, including the null end marker.
  onReadableEnd: (callback: () => void) => void
  end: () => void
  destroy: (error?: Error) => void
}

export type BrowserNetworkTunnelClientSocketCallbacks = {
  writeBytes: (bytes: Uint8Array<ArrayBufferLike>, callback: (error?: Error | null) => void) => void
  requestRead: () => void
  // Settle only bytes delivered to the downstream consumer, not bytes buffered by the adapter.
  consumeReadBytes: (bytes: number) => void
  finishWrite: (callback: (error?: Error | null) => void) => void
  destroyStream: (error: Error | null, callback: (error?: Error | null) => void) => void
}
