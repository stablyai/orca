import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  extractLastOscTitle
} from '../../../../shared/agent-detection'
import type { OpenCodeStatusEvent } from '../../../../shared/types'
import {
  ptyDataHandlers,
  ptyExitHandlers,
  openCodeStatusHandlers,
  ensurePtyDispatcher,
  getEagerPtyBufferHandle
} from './pty-dispatcher'
import type { PtyTransport, IpcPtyTransportOptions } from './pty-dispatcher'
import { createBellDetector } from './bell-detector'

// Re-export public API so existing consumers keep working.
export {
  ensurePtyDispatcher,
  getEagerPtyBufferHandle,
  registerEagerPtyBuffer
} from './pty-dispatcher'
export type { EagerPtyHandle, PtyTransport, IpcPtyTransportOptions } from './pty-dispatcher'
export { extractLastOscTitle } from '../../../../shared/agent-detection'

export function createIpcPtyTransport(opts: IpcPtyTransportOptions = {}): PtyTransport {
  const {
    cwd,
    env,
    command,
    connectionId,
    worktreeId,
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
  const chunkContainsBell = createBellDetector()
  let suppressAttentionEvents = false
  let lastEmittedTitle: string | null = null
  let lastObservedTerminalTitle: string | null = null
  let openCodeStatus: OpenCodeStatusEvent['status'] | null = null
  let staleTitleTimer: ReturnType<typeof setTimeout> | null = null
  const agentTracker =
    onAgentBecameIdle || onAgentBecameWorking || onAgentExited
      ? createAgentStatusTracker(
          (title) => {
            if (!suppressAttentionEvents) {
              onAgentBecameIdle?.(title)
            }
          },
          onAgentBecameWorking,
          onAgentExited
        )
      : null

  const STALE_TITLE_TIMEOUT = 3000 // ms before stale working title is cleared
  let storedCallbacks: Parameters<PtyTransport['connect']>[0]['callbacks'] = {}

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
    // Why: while OpenCode has an explicit non-idle status, that status is the
    // source of truth — the observed title is only used as context text.
    if (openCodeStatus && openCodeStatus !== 'idle') {
      applyOpenCodeStatus({ ptyId: ptyId ?? '', status: openCodeStatus })
      return
    }

    lastEmittedTitle = normalizeTerminalTitle(title)
    onTitleChange?.(lastEmittedTitle, title)
    agentTracker?.handleTitle(title)
  }

  // Why: shared by connect() and attach() to avoid duplicating title/bell/exit logic.
  function registerPtyDataHandler(id: string): void {
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
        } else if (lastEmittedTitle && detectAgentStatusFromTitle(lastEmittedTitle) === 'working') {
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
      if (onBell && chunkContainsBell(data) && !suppressAttentionEvents) {
        onBell()
      }
    })
  }

  function registerPtyExitHandler(id: string): void {
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
          env,
          command,
          ...(connectionId ? { connectionId } : {}),
          worktreeId
        })

        // If destroyed while spawn was in flight, kill the new pty and bail
        if (destroyed) {
          window.api.pty.kill(result.id)
          return
        }

        ptyId = result.id
        connected = true
        onPtySpawn?.(result.id)

        registerPtyDataHandler(result.id)
        registerPtyExitHandler(result.id)

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
      // Why: skip onPtySpawn — it would reset lastActivityAt and destroy the
      // recency sort order that reconnectPersistedTerminals preserved.
      registerPtyDataHandler(id)
      registerPtyExitHandler(id)

      // Why: replay buffered data through the real handler so title/bell/agent
      // tracking processes the output — otherwise restored tabs keep a default title.
      const bufferHandle = getEagerPtyBufferHandle(id)
      if (bufferHandle) {
        const buffered = bufferHandle.flush()
        if (buffered) {
          // Why: eager PTY buffers contain output produced before the pane
          // attached, often from a previous app session. We still replay that
          // data so titles and scrollback restore correctly, but it must not
          // generate fresh unread badges or notifications for unrelated
          // worktrees just because Orca is reconnecting background terminals.
          suppressAttentionEvents = true
          try {
            ptyDataHandlers.get(id)?.(buffered)
          } finally {
            suppressAttentionEvents = false
          }
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
}
