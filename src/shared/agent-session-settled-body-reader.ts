import type { NativeChatResolvedPrompt } from './native-chat-resolution-receipt'
import { createAgentSessionJsonAssembly } from './agent-session-json-pieces'
import {
  AgentSessionSettledBodyPieceSchema,
  AGENT_SESSION_SETTLED_BODY_MAX_UNITS,
  isExactSettledApprovalBody,
  sameAgentSessionSettledSource,
  type AgentSessionSettledBodyRead,
  type AgentSessionSettledBodySource
} from './agent-session-settled-body'
import type { AgentJournalApprovalItem } from './agent-session-journal-types'
import {
  reserveRemoteRuntimeRetainedBytes,
  subscribeRemoteRuntimeAdmissionRelease
} from './remote-runtime/requests/remote-runtime-prepared-request-admission'
import { createReconnectScheduler } from './structured-agent-session-reconnect'
import { readAgentSessionErrorRefusal } from './agent-session-write-failure'

export type SettledBodyReadState =
  | { status: 'loading' }
  | { status: 'ready'; body: AgentJournalApprovalItem }
  | { status: 'error' }
const LOADING: SettledBodyReadState = { status: 'loading' }
const ERROR: SettledBodyReadState = { status: 'error' }
type Lease = NonNullable<ReturnType<typeof reserveRemoteRuntimeRetainedBytes>>
type Entry = {
  source: AgentSessionSettledBodySource
  state: SettledBodyReadState
  listeners: Set<() => void>
  running: boolean
  retired: boolean
  lease?: Lease
  start: () => void
  stopRetry: () => void
}
const entries = new Set<Entry>()
let active = 0
function drain(): void {
  for (const entry of entries) {
    if (!entry.retired && !entry.running && entry.state.status === 'loading') {
      entry.start()
    }
  }
}

subscribeRemoteRuntimeAdmissionRelease(drain)

/** One session/connection namespace; completed values are shared references, never session-state copies. */
export function createAgentSessionSettledBodyReader(
  read: (request: AgentSessionSettledBodyRead) => Promise<unknown>
) {
  const owned = new Map<string, Entry>()
  let disposed = false
  let ownerRunning = false
  const key = (source: AgentSessionSettledBodySource) => JSON.stringify(source)
  function remove(entry: Entry): void {
    entry.lease?.release()
    entry.lease = undefined
    entries.delete(entry)
    if (owned.get(key(entry.source)) === entry) {
      owned.delete(key(entry.source))
    }
    entry.stopRetry()
  }
  function publish(entry: Entry, state: SettledBodyReadState): void {
    entry.state = state
    for (const listener of entry.listeners) {
      listener()
    }
  }
  function acquire(source: AgentSessionSettledBodySource): Entry | undefined {
    const id = key(source)
    const held = owned.get(id)
    if (held && !held.retired) {
      return held
    }
    if (disposed || entries.size >= 64) {
      return undefined
    }
    const metadataBytes = id.length * 3 + 256
    const metadata = reserveRemoteRuntimeRetainedBytes(metadataBytes)
    if (!metadata) {
      return undefined
    }
    const entry: Entry = {
      source,
      lease: metadata,
      state: LOADING,
      running: false,
      retired: false,
      listeners: new Set(),
      start: () => {},
      stopRetry: () => {}
    }
    const retry = createReconnectScheduler({
      shouldStop: () => entry.retired || disposed,
      reconnect: () => {
        publish(entry, LOADING)
        drain()
      }
    })
    entry.stopRetry = () => retry.dispose()
    entry.start = () => {
      if (entry.running || entry.retired || ownerRunning || active >= 8) {
        return
      }
      // Chunks, joined JSON, parsed scalar strings and the current ordinary piece overlap.
      const lease = entry.lease
      if (
        !lease ||
        !lease.resize(metadataBytes + 6 * AGENT_SESSION_SETTLED_BODY_MAX_UNITS + 256 * 1024)
      ) {
        return
      }
      entry.lease = lease
      entry.running = true
      ownerRunning = true
      active++
      void (async () => {
        const assembly = createAgentSessionJsonAssembly(AGENT_SESSION_SETTLED_BODY_MAX_UNITS, true)
        let reading = false
        try {
          while (!entry.retired && !disposed) {
            reading = true
            const timeout = setTimeout(() => {
              if (!entry.retired && !disposed) {
                publish(entry, ERROR)
              }
            }, 30_000)
            let response: unknown
            try {
              response = await read({ ...entry.source, cursor: assembly.cursor })
            } finally {
              clearTimeout(timeout)
            }
            reading = false
            const piece = AgentSessionSettledBodyPieceSchema.parse(response)
            if (entry.retired || disposed) {
              return
            }
            if (!sameAgentSessionSettledSource(entry.source, piece.source)) {
              throw new Error('Saved answer source changed')
            }
            const complete = assembly.accept(piece)
            if (!complete) {
              continue
            }
            if (!isExactSettledApprovalBody(complete.value, source.state)) {
              throw new Error('Invalid saved answer')
            }
            if (!lease.resize(metadataBytes + assembly.cursor * 2 + 64 * 1024)) {
              throw new Error('Saved answer read busy')
            }
            retry.reset()
            publish(entry, { status: 'ready', body: complete.value })
            return
          }
        } catch (error) {
          if (!entry.retired && !disposed) {
            publish(entry, ERROR)
            if (reading && readAgentSessionErrorRefusal(error) === undefined) {
              retry.schedule()
            }
          }
        } finally {
          active--
          entry.running = false
          ownerRunning = false
          if (entry.retired || disposed) {
            remove(entry)
          } else if (entry.state.status !== 'ready') {
            lease.resize(metadataBytes)
          }
          drain()
        }
      })()
    }
    entries.add(entry)
    owned.set(id, entry)
    return entry
  }
  return {
    getSnapshot(source: AgentSessionSettledBodySource): SettledBodyReadState {
      return owned.get(key(source))?.state ?? ERROR
    },
    subscribe(source: AgentSessionSettledBodySource, listener: () => void): () => void {
      const entry = acquire(source)
      if (!entry) {
        queueMicrotask(listener)
        return () => {}
      }
      entry.listeners.add(listener)
      drain()
      return () => {
        entry.listeners.delete(listener)
        if (entry.listeners.size === 0) {
          entry.retired = true
          entry.stopRetry()
          if (owned.get(key(entry.source)) === entry) {
            owned.delete(key(entry.source))
          }
          if (!entry.running) {
            remove(entry)
            drain()
          }
        }
      }
    },
    clear(): void {
      for (const entry of owned.values()) {
        entry.retired = true
        entry.stopRetry()
        if (!entry.running) {
          remove(entry)
        }
      }
      owned.clear()
      drain()
    },
    retry(): void {
      for (const entry of owned.values()) {
        if (entry.state.status === 'error' && !entry.retired) {
          publish(entry, LOADING)
        }
      }
      drain()
    },
    dispose(): void {
      disposed = true
      for (const entry of owned.values()) {
        entry.retired = true
        entry.stopRetry()
        if (!entry.running) {
          remove(entry)
        }
      }
      drain()
    }
  }
}

export type AgentSessionSettledBodyReader = ReturnType<typeof createAgentSessionSettledBodyReader>

export type AgentSessionSettledBodyOwner = {
  reader: AgentSessionSettledBodyReader
  sessionId: string
  epoch: string | null
}
export function receiptSettledBodySource(
  owner: AgentSessionSettledBodyOwner | null,
  body: NativeChatResolvedPrompt
): AgentSessionSettledBodySource | null {
  return owner?.epoch && body.deferredBody
    ? {
        ...body.deferredBody.descriptor,
        sessionId: owner.sessionId,
        epoch: owner.epoch,
        itemId: body.deferredBody.itemId,
        revision: body.deferredBody.revision
      }
    : null
}
