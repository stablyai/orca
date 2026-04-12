/* eslint-disable max-lines */
import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  extractLastOscTitle
} from '../../../../shared/agent-detection'
import type { OpenCodeStatusEvent } from '../../../../shared/types'

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

// Singleton PTY event dispatcher — one global IPC listener per channel,
// routes events to transports by PTY ID. Eliminates the N-listener problem
// that triggers MaxListenersExceededWarning with many panes/tabs.
const ptyDataHandlers = new Map<string, (data: string) => void>()
const ptyExitHandlers = new Map<string, (code: number) => void>()
const openCodeStatusHandlers = new Map<string, (event: OpenCodeStatusEvent) => void>()
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

// ─── Eager PTY buffer for reconnection on restart ───────────────────
// Why: On startup, PTYs are spawned before TerminalPane mounts. Shell output
// (prompt, MOTD) arrives via pty:data before xterm exists. These helpers buffer
// that output so transport.attach() can replay it when the pane finally mounts.

type EagerPtyHandle = { flush: () => string; dispose: () => void }
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

// extractLastOscTitle is now imported from shared/agent-detection.ts
// Re-export for consumers that import it from this module.
export { extractLastOscTitle } from '../../../../shared/agent-detection'

export type IpcPtyTransportOptions = {
  cwd?: string
  env?: Record<string, string>
  onPtyExit?: (ptyId: string) => void
  onTitleChange?: (title: string, rawTitle: string) => void
  onPtySpawn?: (ptyId: string) => void
  onBell?: () => void
  onAgentBecameIdle?: (title: string) => void
  onAgentBecameWorking?: () => void
  onAgentExited?: () => void
}

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    cwd,
    env,
    onPtyExit,
    onTitleChange,
    onPtySpawn,
    onBell,
    onAgentBecameIdle,
    onAgentBecameWorking,
    onAgentExited
  } = opts
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  let pendingEscape = false
  let inOsc = false
  let pendingOscEscape = false
  let lastEmittedTitle: string | null = null
  let lastObservedTerminalTitle: string | null = null
  let openCodeStatus: OpenCodeStatusEvent['status'] | null = null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          onAgentBecameIdle ?? (() => {}),
          onAgentBecameWorking,
          onAgentExited
        )
      : null

  // How long data must flow without a title update before we consider
  // the last agent-working title stale and clear it (ms).
  const STALE_TITLE_TIMEOUT = 3000
  let storedCallbacks: {
    onConnect?: () => void
    onDisconnect?: () => void
    onData?: (data: string) => void
    onStatus?: (shell: string) => void
    onError?: (message: string, errors?: string[]) => void
    onExit?: (code: number) => void
  } = {}

  function unregisterPtyHandlers(id: string): void {
    ptyDataHandlers.delete(id)
    ptyExitHandlers.delete(id)
    openCodeStatusHandlers.delete(id)
  }

  function getSyntheticOpenCodeTitle(status: OpenCodeStatusEvent['status']): string {
    const baseTitle =
      lastObservedTerminalTitle && lastObservedTerminalTitle !== 'OpenCode'
        ? `OpenCode · ${lastObservedTerminalTitle}`
        : 'OpenCode'

    if (status === 'working') {
      return `⠋ ${baseTitle}`
    }
    if (status === 'permission') {
      return `${baseTitle} permission needed`
    }
    return baseTitle
  }

  function applyOpenCodeStatus(event: OpenCodeStatusEvent): void {
    openCodeStatus = event.status
    if (staleTitleTimer) {
      clearTimeout(staleTitleTimer)
      staleTitleTimer = null
    }

    const rawTitle = getSyntheticOpenCodeTitle(event.status)
    const title = normalizeTerminalTitle(rawTitle)
    lastEmittedTitle = title
    onTitleChange?.(title, rawTitle)
    agentTracker?.handleTitle(rawTitle)
  }

  function applyObservedTerminalTitle(title: string): void {
    lastObservedTerminalTitle = title

    // Why: OpenCode can keep emitting plain titles like "OpenCode" while the
    // session is still busy. If we let those raw titles overwrite the
    // hook-derived state, the working spinner flashes briefly and disappears.
    // While OpenCode has an explicit non-idle status, that status is the
    // source of truth and the observed title is only used as context text.
    if (openCodeStatus && openCodeStatus !== 'idle') {
      applyOpenCodeStatus({ ptyId: ptyId ?? '', status: openCodeStatus })
      return
    }

    lastEmittedTitle = normalizeTerminalTitle(title)
    onTitleChange?.(lastEmittedTitle, title)
    agentTracker?.handleTitle(title)
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      if (destroyed) {
        return
      }

      try {
        const result = await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd,
          env
        })

        // If destroyed while spawn was in flight, kill the new pty and bail
        if (destroyed) {
          window.api.pty.kill(result.id)
          return
        }

        ptyId = result.id
        connected = true
        onPtySpawn?.(result.id)

        ptyDataHandlers.set(result.id, (data) => {
          storedCallbacks.onData?.(data)
          if (onTitleChange) {
            const title = extractLastOscTitle(data)
            if (title !== null) {
              // Got a fresh title — clear any pending stale-title timer
              if (staleTitleTimer) {
                clearTimeout(staleTitleTimer)
                staleTitleTimer = null
              }
              applyObservedTerminalTitle(title)
            } else if (
              lastEmittedTitle &&
              detectAgentStatusFromTitle(lastEmittedTitle) === 'working'
            ) {
              // Data flowing but no title update — the agent may have exited.
              // Start/restart a debounce timer to clear the stale working title.
              if (staleTitleTimer) {
                clearTimeout(staleTitleTimer)
              }
              staleTitleTimer = setTimeout(() => {
                staleTitleTimer = null
                if (
                  lastEmittedTitle &&
                  detectAgentStatusFromTitle(lastEmittedTitle) === 'working'
                ) {
                  const cleared = clearWorkingIndicators(lastEmittedTitle)
                  lastEmittedTitle = cleared
                  onTitleChange(cleared, cleared)
                  agentTracker?.handleTitle(cleared)
                }
              }, STALE_TITLE_TIMEOUT)
            }
          }
          if (onBell && chunkContainsBell(data)) {
            onBell()
          }
        })

        const spawnedId = result.id
        ptyExitHandlers.set(spawnedId, (code) => {
          if (staleTitleTimer) {
            clearTimeout(staleTitleTimer)
            staleTitleTimer = null
          }
          openCodeStatus = null
          connected = false
          ptyId = null
          unregisterPtyHandlers(spawnedId)
          storedCallbacks.onExit?.(code)
          storedCallbacks.onDisconnect?.()
          onPtyExit?.(spawnedId)
        })
        openCodeStatusHandlers.set(spawnedId, applyOpenCodeStatus)

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        storedCallbacks.onError?.(msg)
      }
    },

    attach(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      if (destroyed) {
        return
      }

      const id = options.existingPtyId
      ptyId = id
      connected = true
      // Why: intentionally skip onPtySpawn here. onPtySpawn feeds into
      // updateTabPtyId → bumpWorktreeActivity, which would reset the
      // worktree's lastActivityAt to now, destroying the recency sort order
      // that reconnectPersistedTerminals explicitly preserved.

      // Replace the temporary eager-buffer handlers with real xterm handlers.
      ptyDataHandlers.set(id, (data) => {
        storedCallbacks.onData?.(data)
        if (onTitleChange) {
          const title = extractLastOscTitle(data)
          if (title !== null) {
            if (staleTitleTimer) {
              clearTimeout(staleTitleTimer)
              staleTitleTimer = null
            }
            applyObservedTerminalTitle(title)
          } else if (
            lastEmittedTitle &&
            detectAgentStatusFromTitle(lastEmittedTitle) === 'working'
          ) {
            if (staleTitleTimer) {
              clearTimeout(staleTitleTimer)
            }
            staleTitleTimer = setTimeout(() => {
              staleTitleTimer = null
              if (lastEmittedTitle && detectAgentStatusFromTitle(lastEmittedTitle) === 'working') {
                const cleared = clearWorkingIndicators(lastEmittedTitle)
                lastEmittedTitle = cleared
                onTitleChange(cleared, cleared)
                agentTracker?.handleTitle(cleared)
              }
            }, STALE_TITLE_TIMEOUT)
          }
        }
        if (onBell && chunkContainsBell(data)) {
          onBell()
        }
      })

      ptyExitHandlers.set(id, (code) => {
        if (staleTitleTimer) {
          clearTimeout(staleTitleTimer)
          staleTitleTimer = null
        }
        openCodeStatus = null
        connected = false
        ptyId = null
        unregisterPtyHandlers(id)
        storedCallbacks.onExit?.(code)
        storedCallbacks.onDisconnect?.()
        onPtyExit?.(id)
      })
      openCodeStatusHandlers.set(id, applyOpenCodeStatus)

      // Replay any data buffered between eager spawn and now. Route through
      // the real data handler (not storedCallbacks.onData directly) so that
      // OSC title extraction, agent status tracking, and bell detection all
      // process the buffered output — otherwise restored tabs keep a default
      // title until later output arrives.
      const bufferHandle = getEagerPtyBufferHandle(id)
      if (bufferHandle) {
        const buffered = bufferHandle.flush()
        if (buffered) {
          ptyDataHandlers.get(id)?.(buffered)
        }
        bufferHandle.dispose()
      }

      // Resize to the actual terminal dimensions (eager spawn used defaults).
      if (options.cols && options.rows) {
        window.api.pty.resize(id, options.cols, options.rows)
      }

      storedCallbacks.onConnect?.()
      storedCallbacks.onStatus?.('shell')
    },

    disconnect() {
      if (staleTitleTimer) {
        clearTimeout(staleTitleTimer)
        staleTitleTimer = null
      }
      openCodeStatus = null
      if (ptyId) {
        const id = ptyId
        window.api.pty.kill(id)
        connected = false
        ptyId = null
        unregisterPtyHandlers(id)
        storedCallbacks.onDisconnect?.()
      }
    },

    preserve() {
      if (staleTitleTimer) {
        clearTimeout(staleTitleTimer)
        staleTitleTimer = null
      }
      if (!ptyId) {
        destroyed = true
        connected = false
        return
      }
      const id = ptyId
      // Why: split-group creation currently remounts TerminalPane while the
      // underlying terminal tab still exists. We must detach this renderer's
      // listeners without killing the PTY so the next mount can re-attach to
      // the same live shell instead of spawning a fresh one and losing work.
      unregisterPtyHandlers(id)
      connected = false
    },

    sendInput(data: string): boolean {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.write(ptyId, data)
      return true
    },

    resize(cols: number, rows: number): boolean {
      if (!connected || !ptyId) {
        return false
      }
      window.api.pty.resize(ptyId, cols, rows)
      return true
    },

    isConnected() {
      return connected
    },

    getPtyId() {
      return ptyId
    },

    destroy() {
      destroyed = true
      this.disconnect()
    }
  }

  function chunkContainsBell(data: string): boolean {
    for (let i = 0; i < data.length; i += 1) {
      const char = data[i]

      if (inOsc) {
        if (pendingOscEscape) {
          pendingOscEscape = char === '\x1b'
          if (char === '\\') {
            inOsc = false
            pendingOscEscape = false
          }
          continue
        }

        if (char === '\x07') {
          inOsc = false
          continue
        }

        pendingOscEscape = char === '\x1b'
        continue
      }

      if (pendingEscape) {
        pendingEscape = false
        if (char === ']') {
          inOsc = true
          pendingOscEscape = false
        } else if (char === '\x1b') {
          pendingEscape = true
        }
        continue
      }

      if (char === '\x1b') {
        pendingEscape = true
        continue
      }

      if (char === '\x07') {
        return true
      }
    }

    return false
  }
}
