// Why: mobile terminal streaming needs the exact screen state from the
// desktop's xterm.js instance. This module maintains a global registry of
// serialize functions keyed by ptyId, and handles IPC requests from the
// main process to serialize a specific terminal's buffer.

import type { IDisposable } from '@xterm/xterm'

export type SerializeOpts = {
  scrollbackRows?: number
  altScreenForcesZeroRows?: boolean
}

export type SerializedBuffer = {
  data: string
  cols: number
  rows: number
  lastTitle?: string
}

export type SerializeFn = (
  opts?: SerializeOpts
) => SerializedBuffer | null | Promise<SerializedBuffer | null>

// Why: ownership tokens prevent a disposed StrictMode first-mount from clobbering
// the live registration of a remounted pane. Each registration mints a fresh
// owner symbol; the unregister closure only deletes when the entry's owner
// matches its captured token.
type SerializerEntry = {
  fn: SerializeFn
  owner: symbol
}

type TitleEntry = {
  title: string
  owner: symbol
  disposable: IDisposable
}

const serializersByPtyId = new Map<string, SerializerEntry>()
const lastTitleByPtyId = new Map<string, TitleEntry>()
let listenerAttached = false

export function registerPtySerializer(ptyId: string, serialize: SerializeFn): () => void {
  const owner = Symbol(ptyId)
  serializersByPtyId.set(ptyId, { fn: serialize, owner })
  ensureSerializerListener()
  return () => {
    const current = serializersByPtyId.get(ptyId)
    if (current?.owner === owner) {
      serializersByPtyId.delete(ptyId)
    }
    const titleEntry = lastTitleByPtyId.get(ptyId)
    if (titleEntry?.owner === owner) {
      // Why: dispose the xterm onTitleChange IDisposable alongside the map
      // cleanup. Without this, the listener stays attached to xterm's emitter
      // for the lifetime of the xterm instance, firing against a torn-down
      // pane (or worse, leaking during HMR).
      titleEntry.disposable.dispose()
      lastTitleByPtyId.delete(ptyId)
    }
  }
}

// Why: the renderer pane installs an onTitleChange wrapper at the same time
// it registers the serializer. The wrapper updates lastTitleByPtyId so the
// IPC response payload can carry the latest observed title without needing
// the renderer to round-trip xterm state on every serializeBuffer request.
// xterm's SerializeAddon does NOT round-trip OSC 0/1/2 title sequences, so
// this is the only channel that gets the title back to the main process.
export function registerPtyTitleSource(
  ptyId: string,
  attach: (handler: (title: string) => void) => IDisposable
): () => void {
  const serializerOwner = serializersByPtyId.get(ptyId)?.owner
  if (!serializerOwner) {
    // Why: the title source must be registered AFTER the serializer so the
    // owner token is available. Calling out of order is a programming bug.
    throw new Error(`registerPtyTitleSource called before serializer for ptyId ${ptyId}`)
  }
  const disposable = attach((title) => {
    const current = lastTitleByPtyId.get(ptyId)
    if (current && current.owner !== serializerOwner) {
      return
    }
    lastTitleByPtyId.set(ptyId, { title, owner: serializerOwner, disposable })
  })
  // Seed an entry with an empty title so the disposable is tracked even
  // before the first onTitleChange fires. Subsequent updates overwrite it.
  const existing = lastTitleByPtyId.get(ptyId)
  if (!existing) {
    lastTitleByPtyId.set(ptyId, { title: '', owner: serializerOwner, disposable })
  }
  return () => {
    const entry = lastTitleByPtyId.get(ptyId)
    if (entry?.owner === serializerOwner) {
      entry.disposable.dispose()
      lastTitleByPtyId.delete(ptyId)
    }
  }
}

export function hasPtySerializer(ptyId: string): boolean {
  return serializersByPtyId.has(ptyId)
}

function ensureSerializerListener(): void {
  if (listenerAttached) {
    return
  }
  listenerAttached = true

  window.api.pty.onSerializeBufferRequest((request) => {
    const entry = serializersByPtyId.get(request.ptyId)
    void Promise.resolve(entry?.fn(request.opts) ?? null)
      .then((result) => {
        if (!result) {
          window.api.pty.sendSerializedBuffer(request.requestId, null)
          return
        }
        const titleEntry = lastTitleByPtyId.get(request.ptyId)
        const lastTitle = titleEntry && titleEntry.title.length > 0 ? titleEntry.title : undefined
        const payload: SerializedBuffer = {
          data: result.data,
          cols: result.cols,
          rows: result.rows
        }
        if (lastTitle !== undefined) {
          payload.lastTitle = lastTitle
        } else if (result.lastTitle !== undefined) {
          payload.lastTitle = result.lastTitle
        }
        window.api.pty.sendSerializedBuffer(request.requestId, payload)
      })
      .catch(() => {
        window.api.pty.sendSerializedBuffer(request.requestId, null)
      })
  })
}
