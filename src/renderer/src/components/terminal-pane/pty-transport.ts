/* oxlint-disable max-lines */
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
  ptyTeardownHandlers,
  ensurePtyDispatcher,
  getEagerPtyBufferHandle
} from './pty-dispatcher'
import type { PtyTransport, IpcPtyTransportOptions, PtyConnectResult } from './pty-dispatcher'
import { createBellDetector } from './bell-detector'

// Re-export public API so existing consumers keep working.
export {
  ensurePtyDispatcher,
  getEagerPtyBufferHandle,
  registerEagerPtyBuffer,
  unregisterPtyDataHandlers
} from './pty-dispatcher'
export type {
  EagerPtyHandle,
  PtyTransport,
  PtyConnectResult,
  IpcPtyTransportOptions
} from './pty-dispatcher'
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
    ptyTeardownHandlers.delete(id)
  }

  function unregisterPtyDataAndStatusHandlers(id: string): void {
    ptyDataHandlers.delete(id)
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

  // Why: true while we're replaying buffered/attach-time bytes into the
  // terminal. Routes those bytes through onReplayData so the renderer can
  // engage the replay guard — otherwise xterm auto-replies to embedded
  // query sequences leak into the shell as stray input.
  let replayingBufferedData = false

  // Why: shared by connect() and attach() to avoid duplicating title/bell/exit logic.
  function registerPtyDataHandler(id: string): void {
    ptyDataHandlers.set(id, (data) => {
      if (replayingBufferedData && storedCallbacks.onReplayData) {
        storedCallbacks.onReplayData(data)
      } else {
        storedCallbacks.onData?.(data)
      }
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

  function clearAccumulatedState(): void {
    if (staleTitleTimer) {
      clearTimeout(staleTitleTimer)
      staleTitleTimer = null
    }
    agentTracker?.reset()
    openCodeStatus = null
  }

  function registerPtyExitHandler(id: string): void {
    ptyExitHandlers.set(id, (code) => {
      clearAccumulatedState()
      connected = false
      ptyId = null
      unregisterPtyHandlers(id)
      storedCallbacks.onExit?.(code)
      storedCallbacks.onDisconnect?.()
      onPtyExit?.(id)
    })
    openCodeStatusHandlers.set(id, applyOpenCodeStatus)
    // Why: shutdownWorktreeTerminals bypasses the transport layer — it
    // kills PTYs directly via IPC without calling disconnect()/destroy().
    // This teardown callback lets unregisterPtyDataHandlers cancel
    // accumulated closure state (staleTitleTimer, agent tracker) that
    // would otherwise fire stale notifications after the data handler
    // is removed but before the exit event arrives.
    ptyTeardownHandlers.set(id, clearAccumulatedState)
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
          ...(options.sessionId ? { sessionId: options.sessionId } : {}),
          worktreeId
        })

        // If destroyed while spawn was in flight, kill the new pty and bail
        if (destroyed) {
          window.api.pty.kill(result.id)
          return
        }

        ptyId = result.id
        connected = true

        // Why: for deferred reattach (Option 2), the daemon returns snapshot/
        // coldRestore data from createOrAttach. Skip onPtySpawn for reattach —
        // it would reset lastActivityAt and destroy the recency sort order.
        if (!result.isReattach && !result.coldRestore) {
          onPtySpawn?.(result.id)
        }

        registerPtyDataHandler(result.id)
        registerPtyExitHandler(result.id)

        storedCallbacks.onConnect?.()
        storedCallbacks.onStatus?.('shell')

        if (result.isReattach || result.coldRestore) {
          return {
            id: result.id,
            snapshot: result.snapshot,
            isAlternateScreen: result.isAlternateScreen,
            coldRestore: result.coldRestore
          } satisfies PtyConnectResult
        }
        return result.id
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        // Why: on cold start, SSH provider isn't registered yet so pty:spawn
        // throws a raw IPC error. Replace with a friendly message since this
        // is an expected state, not an application crash.
        if (connectionId && msg.includes('No PTY provider for connection')) {
          storedCallbacks.onError?.(
            'SSH connection is not active. Use the reconnect dialog or Settings to connect.'
          )
        } else {
          storedCallbacks.onError?.(msg)
        }
        return undefined
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

      const bufferHandle = getEagerPtyBufferHandle(id)
      if (bufferHandle) {
        const buffered = bufferHandle.flush()
        if (buffered) {
          // Why: eager PTY buffers contain output produced before the pane
          // attached, often from a previous app session. We still replay that
          // data so titles and scrollback restore correctly, but it must not
          // generate fresh unread badges or notifications for unrelated
          // worktrees just because Orca is reconnecting background terminals.
          // Why replayingBufferedData: those buffered bytes are raw PTY output
          // that may contain query sequences from the previous session; route
          // them through onReplayData so the renderer engages the replay guard
          // and xterm's auto-replies do not leak into the shell.
          suppressAttentionEvents = true
          replayingBufferedData = true
          try {
            ptyDataHandlers.get(id)?.(buffered)
          } finally {
            replayingBufferedData = false
            suppressAttentionEvents = false
          }
        }
        bufferHandle.dispose()
      }

      // Why: clear the display before writing the snapshot so restored
      // content doesn't layer on top of stale output. Skip the clear for
      // alternate-screen sessions — the snapshot already fills the screen
      // and clearing would erase it.
      // Why onReplayData: treat this clear as replay-path too so any data
      // that immediately follows from the renderer sits under the same guard.
      if (!options.isAlternateScreen) {
        const clear = '\x1b[2J\x1b[3J\x1b[H'
        if (storedCallbacks.onReplayData) {
          storedCallbacks.onReplayData(clear)
        } else {
          storedCallbacks.onData?.(clear)
        }
      }

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

    detach() {
      if (staleTitleTimer) {
        clearTimeout(staleTitleTimer)
        staleTitleTimer = null
      }
      openCodeStatus = null
      if (ptyId) {
        // Why: detach() is used for in-session remounts such as moving a tab
        // between split groups. Stop delivering data/title events into the
        // unmounted pane immediately, but keep the PTY exit observer alive so
        // a shell that dies during the remount gap can still clear stale
        // tab/leaf bindings before the next pane attempts to reattach.
        unregisterPtyDataAndStatusHandlers(ptyId)
      }
      connected = false
      ptyId = null
      storedCallbacks = {}
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
