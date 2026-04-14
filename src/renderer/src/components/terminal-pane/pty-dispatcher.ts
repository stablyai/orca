/**
 * Singleton PTY event dispatcher and eager buffer helpers.
 *
 * Why extracted: keeps pty-transport.ts under the 300-line limit while
 * co-locating the global handler maps that both the transport factory
 * and the eager-buffer reconnection logic share.
 */
import type { OpenCodeStatusEvent } from '../../../../shared/types'

// ── Singleton PTY event dispatcher ───────────────────────────────────
// One global IPC listener per channel, routes events to transports by
// PTY ID. Eliminates the N-listener problem that triggers
// MaxListenersExceededWarning with many panes/tabs.

export const ptyDataHandlers = new Map<string, (data: string) => void>()
export const ptyExitHandlers = new Map<string, (code: number) => void>()
export const openCodeStatusHandlers = new Map<string, (event: OpenCodeStatusEvent) => void>()
let ptyDispatcherAttached = false

export function ensurePtyDispatcher(): void {
  if (ptyDispatcherAttached) {
    return
  }
  ptyDispatcherAttached = true
  window.api.pty.onData((payload) => {
    ptyDataHandlers.get(payload.id)?.(payload.data)
  })
  window.api.pty.onExit((payload) => {
    ptyExitHandlers.get(payload.id)?.(payload.code)
  })
  window.api.pty.onOpenCodeStatus((payload) => {
    openCodeStatusHandlers.get(payload.ptyId)?.(payload)
  })
}

// ─── Eager PTY buffer for reconnection on restart ────────────────────
// Why: On startup, PTYs are spawned before TerminalPane mounts. Shell output
// (prompt, MOTD) arrives via pty:data before xterm exists. These helpers buffer
// that output so transport.attach() can replay it when the pane finally mounts.

export type EagerPtyHandle = { flush: () => string; dispose: () => void }
const eagerPtyHandles = new Map<string, EagerPtyHandle>()

export function getEagerPtyBufferHandle(ptyId: string): EagerPtyHandle | undefined {
  return eagerPtyHandles.get(ptyId)
}

// Why: 512 KB matches the scrollback buffer cap used by TerminalPane's
// serialization. Prevents unbounded memory growth if a restored shell
// runs a long-lived command (e.g. tail -f) in a worktree the user never opens.
const EAGER_BUFFER_MAX_BYTES = 512 * 1024

export function registerEagerPtyBuffer(
  ptyId: string,
  onExit: (ptyId: string, code: number) => void
): EagerPtyHandle {
  ensurePtyDispatcher()

  const buffer: string[] = []
  let bufferBytes = 0

  const dataHandler = (data: string): void => {
    buffer.push(data)
    bufferBytes += data.length
    // Trim from the front when the buffer exceeds the cap, keeping the
    // most recent output which contains the shell prompt.
    while (bufferBytes > EAGER_BUFFER_MAX_BYTES && buffer.length > 1) {
      bufferBytes -= buffer.shift()!.length
    }
  }
  const exitHandler = (code: number): void => {
    // Shell died before TerminalPane attached — clean up and notify the store
    // so the tab's ptyId is cleared and connectPanePty falls through to connect().
    ptyDataHandlers.delete(ptyId)
    ptyExitHandlers.delete(ptyId)
    eagerPtyHandles.delete(ptyId)
    onExit(ptyId, code)
  }

  ptyDataHandlers.set(ptyId, dataHandler)
  ptyExitHandlers.set(ptyId, exitHandler)

  const handle: EagerPtyHandle = {
    flush() {
      const data = buffer.join('')
      buffer.length = 0
      return data
    },
    dispose() {
      // Only remove if the current handler is still the temp one (compare by
      // reference). After attach() replaces the handler this becomes a no-op.
      if (ptyDataHandlers.get(ptyId) === dataHandler) {
        ptyDataHandlers.delete(ptyId)
      }
      if (ptyExitHandlers.get(ptyId) === exitHandler) {
        ptyExitHandlers.delete(ptyId)
      }
      eagerPtyHandles.delete(ptyId)
    }
  }

  eagerPtyHandles.set(ptyId, handle)
  return handle
}

// ── PtyTransport interface ───────────────────────────────────────────
// Why: lives here so pty-transport.ts stays under the 300-line limit.

export type PtyTransport = {
  connect: (options: {
    url: string
    cols?: number
    rows?: number
    callbacks: {
      onConnect?: () => void
      onDisconnect?: () => void
      onData?: (data: string) => void
      onStatus?: (shell: string) => void
      onError?: (message: string, errors?: string[]) => void
      onExit?: (code: number) => void
    }
  }) => void | Promise<void>
  /** Attach to an existing PTY that was eagerly spawned during startup.
   *  Skips pty:spawn — registers handlers and replays buffered data instead. */
  attach: (options: {
    existingPtyId: string
    cols?: number
    rows?: number
    callbacks: {
      onConnect?: () => void
      onDisconnect?: () => void
      onData?: (data: string) => void
      onStatus?: (shell: string) => void
      onError?: (message: string, errors?: string[]) => void
      onExit?: (code: number) => void
    }
  }) => void
  disconnect: () => void
  sendInput: (data: string) => boolean
  resize: (
    cols: number,
    rows: number,
    meta?: { widthPx?: number; heightPx?: number; cellW?: number; cellH?: number }
  ) => boolean
  isConnected: () => boolean
  getPtyId: () => string | null
  preserve?: () => void
  destroy?: () => void | Promise<void>
}

export type IpcPtyTransportOptions = {
  cwd?: string
  env?: Record<string, string>
  command?: string
  connectionId?: string | null
  /** Orca worktree identity for scoped shell history. */
  worktreeId?: string
  onPtyExit?: (ptyId: string) => void
  onTitleChange?: (title: string, rawTitle: string) => void
  onPtySpawn?: (ptyId: string) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
}
