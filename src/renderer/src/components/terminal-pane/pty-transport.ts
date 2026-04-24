/* oxlint-disable max-lines -- Why: the PTY transport manages lifecycle, data flow,
agent status extraction, and title tracking for terminal panes. Splitting would
scatter the tightly coupled IPC ↔ xterm data pipeline across files with no clear
module boundary, making the data flow harder to trace during debugging. */
import {
  detectAgentStatusFromTitle,
  clearWorkingIndicators,
  createAgentStatusTracker,
  normalizeTerminalTitle,
  extractLastOscTitle
} from '../../../../shared/agent-detection'
import {
  ptyDataHandlers,
  ptyExitHandlers,
  ptyTeardownHandlers,
  ensurePtyDispatcher,
  getEagerPtyBufferHandle
} from './pty-dispatcher'
import type { PtyTransport, IpcPtyTransportOptions, PtyConnectResult } from './pty-dispatcher'
import { createBellDetector } from './bell-detector'
import type { ParsedAgentStatusPayload } from '../../../../shared/agent-status-types'
import { parseAgentStatusPayload } from '../../../../shared/agent-status-types'

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

// ─── OSC 9999: agent status reporting ──────────────────────────────────────
// Why OSC 9999: avoids known-used codes (7=cwd, 133=VS Code, 777=Superset,
// 1337=iTerm2, 9001=Warp). Agents report structured status by printing
// printf '\x1b]9999;{"state":"working","prompt":"..."}\x07'
const OSC_AGENT_STATUS_PREFIX = '\x1b]9999;'

export type ProcessedAgentStatusChunk = {
  cleanData: string
  payloads: ParsedAgentStatusPayload[]
}

function findAgentStatusTerminator(
  data: string,
  searchFrom: number
): { index: number; length: 1 | 2 } | null {
  const belIndex = data.indexOf('\x07', searchFrom)
  const stIndex = data.indexOf('\x1b\\', searchFrom)
  if (belIndex === -1 && stIndex === -1) {
    return null
  }
  if (belIndex === -1) {
    return { index: stIndex, length: 2 }
  }
  if (stIndex === -1 || belIndex < stIndex) {
    return { index: belIndex, length: 1 }
  }
  return { index: stIndex, length: 2 }
}

/**
 * Stateful OSC 9999 parser for PTY streams.
 * Why: the design doc explicitly calls out partial reads across chunks. Regexing
 * each chunk independently drops valid status updates when the PTY splits the
 * escape sequence mid-payload and can leak raw control bytes into xterm.
 */
export function createAgentStatusOscProcessor(): (data: string) => ProcessedAgentStatusChunk {
  // Why: cap the pending buffer so a malformed or binary stream containing our
  // OSC 9999 prefix without a valid terminator cannot grow memory unbounded.
  const MAX_PENDING = 64 * 1024
  let pending = ''

  return (data: string): ProcessedAgentStatusChunk => {
    const combined = pending + data
    pending = ''

    const payloads: ParsedAgentStatusPayload[] = []
    let cleanData = ''
    let cursor = 0

    while (cursor < combined.length) {
      const start = combined.indexOf(OSC_AGENT_STATUS_PREFIX, cursor)
      if (start === -1) {
        // Why: if the stream ends on a partial copy of the prefix (e.g. "\x1b]9999"
        // without the trailing ";"), carrying that tail into `pending` lets the
        // next chunk complete the prefix. Without this, the tail would be
        // emitted as plain output and the next chunk's valid status update
        // would be dropped because its prefix is incomplete on its own.
        const tail = combined.slice(cursor)
        const prefixLen = OSC_AGENT_STATUS_PREFIX.length
        let partialPrefixLen = 0
        for (let k = Math.min(prefixLen - 1, tail.length); k > 0; k--) {
          if (tail.endsWith(OSC_AGENT_STATUS_PREFIX.slice(0, k))) {
            partialPrefixLen = k
            break
          }
        }
        if (partialPrefixLen > 0) {
          cleanData += tail.slice(0, tail.length - partialPrefixLen)
          pending = tail.slice(tail.length - partialPrefixLen)
        } else {
          cleanData += tail
        }
        break
      }

      cleanData += combined.slice(cursor, start)
      const payloadStart = start + OSC_AGENT_STATUS_PREFIX.length
      const terminator = findAgentStatusTerminator(combined, payloadStart)

      if (terminator === null) {
        const candidate = combined.slice(start)
        // Why: drop the unterminated OSC entirely when it overflows MAX_PENDING,
        // instead of flushing it to xterm. xterm.js would treat a lone
        // "\x1b]9999;..." as an open string state and could swallow later
        // output until it sees a BEL/ST terminator. Bounding the buffer is the
        // goal; leaking corrupt escape sequences would be worse than the
        // dropped payload.
        pending = candidate.length > MAX_PENDING ? '' : candidate
        break
      }

      const parsed = parseAgentStatusPayload(combined.slice(payloadStart, terminator.index))
      if (parsed) {
        payloads.push(parsed)
      }
      cursor = terminator.index + terminator.length
    }

    return { cleanData, payloads }
  }
}

// Why: onAgentStatus callback added to IpcPtyTransportOptions in pty-dispatcher
// so the OSC 9999 status payloads can be forwarded to the store.

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
    onAgentExited,
    onAgentStatus
  } = opts
  let connected = false
  let destroyed = false
  let ptyId: string | null = null
  const bellDetector = createBellDetector()
  // Why: eager PTY buffers contain output produced before the pane attached —
  // often from the previous app session. We still replay that data so titles
  // and scrollback restore correctly, but it must not produce fresh bells,
  // unread marks, or notifications for unrelated worktrees just because Orca
  // is reconnecting background terminals on launch.
  let suppressAttentionEvents = false
  const processAgentStatusChunk = createAgentStatusOscProcessor()
  let lastEmittedTitle: string | null = null
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
    ptyTeardownHandlers.delete(id)
  }

  function unregisterPtyDataAndStatusHandlers(id: string): void {
    ptyDataHandlers.delete(id)
  }

  function applyObservedTerminalTitle(title: string): void {
    lastEmittedTitle = normalizeTerminalTitle(title)
    onTitleChange?.(lastEmittedTitle, title)
    agentTracker?.handleTitle(title)
  }

  // Why: true while we're replaying buffered/attach-time bytes into the
  // terminal. Routes those bytes through onReplayData so the renderer can
  // engage the replay guard — otherwise xterm auto-replies to embedded
  // query sequences leak into the shell as stray input.
  let replayingBufferedData = false

  // Why: shared by connect() and attach() to avoid duplicating title/bell/exit
  // logic across the two code paths that register a PTY.
  function registerPtyDataHandler(id: string): void {
    ptyDataHandlers.set(id, (data) => {
      // Why: OSC 9999 is a renderer-only control protocol. Parse it before
      // xterm sees the bytes, and keep parser state across chunks so partial
      // PTY reads do not drop valid status updates or print escape garbage.
      const processed = processAgentStatusChunk(data)
      data = processed.cleanData
      // Why: mirror the onBell / onAgentBecameIdle guard below — during eager-buffer
      // replay we must not surface stale agent-status payloads from a prior app
      // session into the live store. The parser still consumes the bytes so they
      // do not leak into xterm, we just suppress the callback.
      if (onAgentStatus && !suppressAttentionEvents) {
        for (const payload of processed.payloads) {
          onAgentStatus(payload)
        }
      }
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
      // Why: BEL is the attention signal. The detector is
      // stateful across chunks so a BEL sitting inside an OSC sequence
      // (e.g. Claude's `\e]0;title\a`) is correctly ignored — only true
      // terminal bells raise attention. suppressAttentionEvents gates this
      // during the synchronous eager-buffer replay so a historical BEL
      // captured from the prior session does not produce a fresh alert on
      // cold reattach.
      if (onBell && bellDetector.chunkContainsBell(data) && !suppressAttentionEvents) {
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
    bellDetector.reset()
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

      // Why: replay buffered data through the real handler so title/bell/agent
      // tracking (including OSC 9999 agent status) processes the output —
      // otherwise restored tabs keep a default title.
      const bufferHandle = getEagerPtyBufferHandle(id)
      if (bufferHandle) {
        const buffered = bufferHandle.flush()
        if (buffered) {
          // Why: eager-buffered bytes are raw PTY output captured before the
          // pane mounted — often from the previous app session. We replay
          // them so titles/scrollback restore correctly, but must silence
          // attention side effects during that replay: a historical BEL
          // or completion captured from the prior session must not produce
          // a fresh bell on the freshly mounted pane.
          //
          // replayingBufferedData additionally routes the bytes through
          // onReplayData so the renderer engages the replay guard — xterm's
          // auto-replies to embedded query sequences would otherwise leak
          // into the shell's stdin.
          suppressAttentionEvents = true
          replayingBufferedData = true
          try {
            ptyDataHandlers.get(id)?.(buffered)
          } finally {
            replayingBufferedData = false
            suppressAttentionEvents = false
            // Why: replaying eager-buffered bytes may have observed a "working" title
            // without a follow-up title, starting a stale-title timer. That timer would
            // fire 3s later — outside the suppression window — and trigger a spurious
            // working→idle transition (and phantom cache-timer write) for a session
            // that was never live in this app instance. Cancel it so the replay has
            // no lingering side effects.
            if (staleTitleTimer) {
              clearTimeout(staleTitleTimer)
              staleTitleTimer = null
            }
            // Why: eager-buffered bytes may end mid-OSC (truncated/partial session
            // data), leaving bellDetector with inOsc = true. Without resetting, the
            // next real BEL in live data would be silently classified as an OSC
            // terminator and dropped. BEL is the sole attention signal per the PR
            // design, so this reset guards the attention pipeline against a silent
            // regression driven by replay state leaking into the live stream.
            bellDetector.reset()
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
      clearAccumulatedState()
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
      clearAccumulatedState()
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
