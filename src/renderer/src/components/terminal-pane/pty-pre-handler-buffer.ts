import { clampUtf8Tail } from './pty-eager-buffer-clamp'
import type { PtyDataMeta } from './pty-dispatcher'

type BufferedPreHandlerPtyData = {
  data: string
  bytes: number
  meta?: PtyDataMeta
}

const preHandlerPtyData = new Map<string, BufferedPreHandlerPtyData[]>()
const preHandlerPtyExit = new Map<string, number>()

// Why: Windows startup commands can emit output before pty:spawn resolves and
// the pane registers its handler. Hold that tiny race window instead of ACKing
// and dropping the first setup-script bytes.
const PRE_HANDLER_PTY_DATA_MAX_BYTES = 512 * 1024
const PRE_HANDLER_PTY_DATA_MAX_PTYS = 64

export function bufferPreHandlerPtyData(ptyId: string, data: string, meta?: PtyDataMeta): void {
  const chunk = clampUtf8Tail(data, PRE_HANDLER_PTY_DATA_MAX_BYTES)
  if (!chunk.data) {
    return
  }
  if (!preHandlerPtyData.has(ptyId) && preHandlerPtyData.size >= PRE_HANDLER_PTY_DATA_MAX_PTYS) {
    const oldestPtyId = preHandlerPtyData.keys().next().value
    if (typeof oldestPtyId === 'string') {
      preHandlerPtyData.delete(oldestPtyId)
    }
  }
  const bufferedMeta =
    meta && chunk.data.length !== data.length && typeof meta.rawLength === 'number'
      ? { ...meta, rawLength: chunk.bytes }
      : meta
  const chunks = preHandlerPtyData.get(ptyId) ?? []
  chunks.push({
    data: chunk.data,
    bytes: chunk.bytes,
    ...(bufferedMeta ? { meta: bufferedMeta } : {})
  })
  let totalBytes = chunks.reduce((total, entry) => total + entry.bytes, 0)
  while (totalBytes > PRE_HANDLER_PTY_DATA_MAX_BYTES && chunks.length > 1) {
    totalBytes -= chunks.shift()?.bytes ?? 0
  }
  preHandlerPtyData.set(ptyId, chunks)
}

export function drainPreHandlerPtyData(
  ptyId: string,
  handler: (data: string, meta?: PtyDataMeta) => void
): void {
  const chunks = preHandlerPtyData.get(ptyId)
  if (!chunks) {
    return
  }
  preHandlerPtyData.delete(ptyId)
  for (const chunk of chunks) {
    handler(chunk.data, chunk.meta)
  }
}

export function bufferPreHandlerPtyExit(ptyId: string, code: number): void {
  preHandlerPtyExit.set(ptyId, code)
}

export function drainPreHandlerPtyExit(ptyId: string, handler: (code: number) => void): void {
  const code = preHandlerPtyExit.get(ptyId)
  if (code === undefined) {
    return
  }
  preHandlerPtyExit.delete(ptyId)
  handler(code)
}

export function clearPreHandlerPtyData(ptyId: string): void {
  preHandlerPtyData.delete(ptyId)
}

export function clearPreHandlerPtyState(ptyId: string): void {
  preHandlerPtyData.delete(ptyId)
  preHandlerPtyExit.delete(ptyId)
}
