import type { Terminal } from '@xterm/xterm'

export type KittyFileRequest = {
  path: string
  offset: number
  length?: number
  signal: AbortSignal
}
export type KittyFileReader = (request: KittyFileRequest) => Promise<Uint8Array>

const readers = new WeakMap<Terminal, KittyFileReader>()

export function bindTerminalKittyFileReader(
  terminal: Terminal,
  reader: KittyFileReader
): () => void {
  readers.set(terminal, reader)
  return () => {
    if (readers.get(terminal) === reader) {
      readers.delete(terminal)
    }
  }
}

export function readTerminalKittyFile(
  terminal: Terminal,
  request: KittyFileRequest
): Promise<Uint8Array> {
  const reader = readers.get(terminal)
  if (!reader) {
    return Promise.reject(new Error('Terminal file transport is unavailable'))
  }
  return reader(request)
}
