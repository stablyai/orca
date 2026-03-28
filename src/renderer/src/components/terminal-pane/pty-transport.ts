import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker
} from '@/lib/agent-status'

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
  disconnect: () => void
  sendInput: (data: string) => boolean
  resize: (
    cols: number,
    rows: number,
    meta?: { widthPx?: number; heightPx?: number; cellW?: number; cellH?: number }
  ) => boolean
  isConnected: () => boolean
  destroy?: () => void | Promise<void>
}

// Singleton PTY event dispatcher — one global IPC listener per channel,
// routes events to transports by PTY ID. Eliminates the N-listener problem
// that triggers MaxListenersExceededWarning with many panes/tabs.
const ptyDataHandlers = new Map<string, (data: string) => void>()
const ptyExitHandlers = new Map<string, (code: number) => void>()
let ptyDispatcherAttached = false

function ensurePtyDispatcher(): void {
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
}

// eslint-disable-next-line no-control-regex -- intentional terminal escape sequence matching
const OSC_TITLE_RE = /\x1b\]([012]);([^\x07\x1b]*?)(?:\x07|\x1b\\)/g

export function extractLastOscTitle(data: string): string | null {
  let last: string | null = null
  let m: RegExpExecArray | null
  OSC_TITLE_RE.lastIndex = 0
  while ((m = OSC_TITLE_RE.exec(data)) !== null) {
    last = m[2]
  }
  return last
}

export type IpcPtyTransportOptions = {
  cwd?: string
  onPtyExit?: (ptyId: string) => void
  onTitleChange?: (title: string) => void
  onPtySpawn?: (ptyId: string) => void
  onBell?: () => void
  onAgentBecameIdle?: () => void
}

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const { cwd, onPtyExit, onTitleChange, onPtySpawn, onBell, onAgentBecameIdle } = opts
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  let pendingEscape = false
  let inOsc = false
  let pendingOscEscape = false
  let lastEmittedTitle: string | null = null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  const agentTracker = onAgentBecameIdle ? createAgentStatusTracker(onAgentBecameIdle) : null

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
  }

  return {
    async connect(options) {
      storedCallbacks = options.callbacks
      ensurePtyDispatcher()

      try {
        const result = await window.api.pty.spawn({
          cols: options.cols ?? 80,
          rows: options.rows ?? 24,
          cwd
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
              lastEmittedTitle = title
              onTitleChange(title)
              agentTracker?.handleTitle(title)
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
                  onTitleChange(cleared)
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
          connected = false
          ptyId = null
          unregisterPtyHandlers(spawnedId)
          storedCallbacks.onExit?.(code)
          storedCallbacks.onDisconnect?.()
          onPtyExit?.(spawnedId)
        })

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        storedCallbacks.onError?.(msg)
      }
    },

    disconnect() {
      if (staleTitleTimer) {
        clearTimeout(staleTitleTimer)
        staleTitleTimer = null
      }
      if (ptyId) {
        const id = ptyId
        window.api.pty.kill(id)
        connected = false
        ptyId = null
        unregisterPtyHandlers(id)
        storedCallbacks.onDisconnect?.()
      }
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
