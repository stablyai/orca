// Serve mobile snapshots from the desktop xterm that owns the exact screen state.

import type { IDisposable } from '@xterm/xterm'

export type SerializeOpts = {
  scrollbackRows?: number
}

export type SerializedBuffer = {
  data: string
  cols: number
  rows: number
  seq?: number
  lastTitle?: string
  /** Kitty flags proven at seq; older hosts’ unknown flags must never become a known zero. */
  kittyKeyboardFlags?: number
  /** Trailing incomplete escape to replay after snapshot reset bytes. */
  pendingEscapeTailAnsi?: string
}

export type SerializeFn = (
  opts?: SerializeOpts
) => SerializedBuffer | null | Promise<SerializedBuffer | null>

// Owner symbols prevent stale StrictMode/unmount cleanup from removing a replacement registration.
type SerializerEntry = {
  fn: SerializeFn
  clear?: () => void
  resetInputModes?: () => void
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

export function registerPtySerializer(
  ptyId: string,
  serialize: SerializeFn,
  actions: Pick<SerializerEntry, 'clear' | 'resetInputModes'> = {}
): () => void {
  const owner = Symbol(ptyId)
  serializersByPtyId.set(ptyId, { fn: serialize, ...actions, owner })
  ensureSerializerListener()
  return () => {
    const current = serializersByPtyId.get(ptyId)
    if (current?.owner === owner) {
      serializersByPtyId.delete(ptyId)
    }
    const titleEntry = lastTitleByPtyId.get(ptyId)
    if (titleEntry?.owner === owner) {
      // Dispose title listeners with their registrations so torn-down panes cannot keep receiving events.
      titleEntry.disposable.dispose()
      lastTitleByPtyId.delete(ptyId)
    }
  }
}

// SerializeAddon omits OSC titles; track title changes separately so snapshots carry the last observed title.
export function registerPtyTitleSource(
  ptyId: string,
  attach: (handler: (title: string) => void) => IDisposable
): () => void {
  const serializerOwner = serializersByPtyId.get(ptyId)?.owner
  if (!serializerOwner) {
    // Register serializers first so title sources can capture their owner token.
    throw new Error(`registerPtyTitleSource called before serializer for ptyId ${ptyId}`)
  }
  const existing = lastTitleByPtyId.get(ptyId)
  const initialTitle = existing?.owner === serializerOwner ? existing.title : ''
  if (existing) {
    // Replace tracked listeners immediately; same-PTY remounts may register before stale cleanup runs.
    existing.disposable.dispose()
    lastTitleByPtyId.delete(ptyId)
  }
  const disposable = attach((title) => {
    const current = lastTitleByPtyId.get(ptyId)
    if (current && current.owner !== serializerOwner) {
      return
    }
    lastTitleByPtyId.set(ptyId, { title, owner: serializerOwner, disposable })
  })
  // Track the disposable before the first title event, even for quiet panes.
  lastTitleByPtyId.set(ptyId, { title: initialTitle, owner: serializerOwner, disposable })
  return () => {
    const entry = lastTitleByPtyId.get(ptyId)
    if (entry?.owner === serializerOwner) {
      entry.disposable.dispose()
      lastTitleByPtyId.delete(ptyId)
    }
  }
}

/** Grounds the pane's own records only; the host grounds its models on its own request. */
export function resetPtyRendererInputModes(ptyId: string): void {
  serializersByPtyId.get(ptyId)?.resetInputModes?.()
}

export function hasPtySerializer(ptyId: string): boolean {
  return serializersByPtyId.has(ptyId)
}

function ensureSerializerListener(): void {
  if (listenerAttached) {
    return
  }
  listenerAttached = true

  window.api.pty.onClearBufferRequest((request) => {
    // Clear the owned xterm so later mobile snapshots cannot resurrect user-cleared scrollback.
    serializersByPtyId.get(request.ptyId)?.clear?.()
  })

  window.api.pty.onResetInputModesRequest((request) => resetPtyRendererInputModes(request.ptyId))

  window.api.pty.onSerializeBufferRequest((request) => {
    const entry = serializersByPtyId.get(request.ptyId)
    void Promise.resolve(entry?.fn(request.opts) ?? null)
      .then((result) => {
        // Fence parse waits against parking/remount replacement so old xterm snapshots cannot publish.
        if (serializersByPtyId.get(request.ptyId) !== entry) {
          window.api.pty.sendSerializedBuffer(request.requestId, null)
          return
        }
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
        if (result.seq !== undefined) {
          payload.seq = result.seq
        }
        // Flags require a sequence boundary so consumers can reconcile subsequent live bytes.
        if (result.seq !== undefined && result.kittyKeyboardFlags !== undefined) {
          payload.kittyKeyboardFlags = result.kittyKeyboardFlags
        }
        if (result.pendingEscapeTailAnsi !== undefined) {
          payload.pendingEscapeTailAnsi = result.pendingEscapeTailAnsi
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
