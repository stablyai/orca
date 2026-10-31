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
  transient: boolean
  metadataBytes: number
  lease?: Lease
  start: () => 'started' | 'occupied' | 'pressure'
  stop: () => void
  retry: () => void
}
const entries = new Set<Entry>()
// Eligibility derives from live selection; no serialized queue/overflow descriptor is retained.
const pending = new Set<Entry>()
let active = 0
let draining = false
function drain(): void {
  if (draining) {
    return
  }
  draining = true
  queueMicrotask(() => {
    draining = false
    for (const entry of pending) {
      if (active >= 8) {
        break
      }
      const result = entry.start()
      if (result === 'pressure') {
        break
      }
      if (result === 'started') {
        pending.delete(entry)
      }
    }
  })
}
subscribeRemoteRuntimeAdmissionRelease(drain)

export function getAgentSessionSettledBodyDemandEvidence() {
  let selected = 0,
    listeners = 0,
    metadataBytes = 0
  for (const entry of entries) {
    if (!entry.retired) {
      selected++
      listeners += entry.listeners.size
      metadataBytes += entry.metadataBytes + entry.listeners.size * 64
    }
  }
  return { selected, listeners, metadataBytes, queuedDescriptors: 0, pending: pending.size, active }
}

/** One session/connection namespace; completed values are shared references. */
export function createAgentSessionSettledBodyReader(
  read: (request: AgentSessionSettledBodyRead) => Promise<unknown>
) {
  const owned = new Map<string, Set<Entry>>()
  let disposed = false
  let ownerRunning = false
  function find(source: AgentSessionSettledBodySource): Entry | undefined {
    for (const entry of owned.get(source.itemId) ?? []) {
      if (sameAgentSessionSettledSource(entry.source, source)) {
        return entry
      }
    }
    return undefined
  }
  function forget(entry: Entry): void {
    const selected = owned.get(entry.source.itemId)
    selected?.delete(entry)
    if (selected?.size === 0) {
      owned.delete(entry.source.itemId)
    }
  }
  function remove(entry: Entry): void {
    entries.delete(entry)
    pending.delete(entry)
    forget(entry)
    entry.stop()
    entry.lease?.release()
    entry.lease = undefined
  }
  function publish(entry: Entry, state: SettledBodyReadState): void {
    if (entry.state === state) {
      return
    }
    entry.state = state
    for (const listener of entry.listeners) {
      listener()
    }
  }
  function acquire(source: AgentSessionSettledBodySource): Entry {
    const held = find(source)
    if (held) {
      return held
    }
    const metadataBytes = JSON.stringify(source).length * 3 + 256
    const entry: Entry = {
      source,
      metadataBytes,
      state: LOADING,
      running: false,
      retired: false,
      transient: false,
      listeners: new Set(),
      start: () => 'occupied',
      stop: () => {},
      retry: () => {}
    }
    let deadline: ReturnType<typeof setTimeout> | undefined
    function endDeadline(): void {
      clearTimeout(deadline)
      deadline = undefined
    }
    function beginDeadline(): void {
      endDeadline()
      deadline = setTimeout(() => {
        deadline = undefined
        if (!entry.retired) {
          publish(entry, ERROR)
        }
      }, 30_000)
    }
    const retry = createReconnectScheduler({
      shouldStop: () => entry.retired || disposed,
      reconnect: () => entry.retry()
    })
    entry.stop = () => {
      endDeadline()
      retry.dispose()
    }
    entry.retry = () => {
      if (entry.running || entry.retired || !entry.transient) {
        return
      }
      pending.add(entry)
      drain()
    }
    entry.start = () => {
      if (entry.running || entry.retired || ownerRunning) {
        return 'occupied'
      }
      const lease = reserveRemoteRuntimeRetainedBytes(
        metadataBytes + 6 * AGENT_SESSION_SETTLED_BODY_MAX_UNITS + 256 * 1024
      )
      if (!lease) {
        return 'pressure'
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
            publish(entry, LOADING)
            beginDeadline()
            reading = true
            const response = await read({ ...source, cursor: assembly.cursor })
            reading = false
            endDeadline()
            if (entry.retired || disposed) {
              return
            }
            const piece = AgentSessionSettledBodyPieceSchema.parse(response)
            if (!sameAgentSessionSettledSource(source, piece.source)) {
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
            entry.transient = false
            retry.reset()
            publish(entry, { status: 'ready', body: complete.value })
            return
          }
        } catch (error) {
          if (!entry.retired && !disposed) {
            entry.transient = reading && readAgentSessionErrorRefusal(error) === undefined
            publish(entry, ERROR)
            if (entry.transient) {
              retry.schedule()
            }
          }
        } finally {
          endDeadline()
          active--
          entry.running = false
          ownerRunning = false
          if (entry.retired || disposed) {
            remove(entry)
          } else if (entry.state.status !== 'ready') {
            entry.lease = undefined
            lease.release()
          }
          drain()
        }
      })()
      return 'started'
    }
    entries.add(entry)
    const selected = owned.get(source.itemId) ?? new Set<Entry>()
    selected.add(entry)
    owned.set(source.itemId, selected)
    pending.add(entry)
    beginDeadline()
    return entry
  }
  function retire(entry: Entry): void {
    entry.retired = true
    entry.listeners.clear()
    entry.stop()
    forget(entry)
    pending.delete(entry)
    if (!entry.running) {
      remove(entry)
    }
  }
  return {
    getSnapshot(source: AgentSessionSettledBodySource): SettledBodyReadState {
      return find(source)?.state ?? ERROR
    },
    subscribe(source: AgentSessionSettledBodySource, listener: () => void): () => void {
      if (disposed) {
        return () => {}
      }
      const entry = acquire(source)
      // Each subscription owns its membership even when callbacks happen to be equal.
      const notify = () => listener()
      entry.listeners.add(notify)
      drain()
      return () => {
        entry.listeners.delete(notify)
        if (entry.listeners.size === 0) {
          retire(entry)
          drain()
        }
      }
    },
    clear(): void {
      for (const selected of owned.values()) {
        for (const entry of selected) {
          retire(entry)
        }
      }
      drain()
    },
    retry(): void {
      for (const selected of owned.values()) {
        for (const entry of selected) {
          entry.retry()
        }
      }
      drain()
    },
    dispose(): void {
      disposed = true
      for (const selected of owned.values()) {
        for (const entry of selected) {
          retire(entry)
        }
      }
      drain()
    }
  }
}

export type AgentSessionSettledBodyReader = ReturnType<typeof createAgentSessionSettledBodyReader>

export * from './agent-session-settled-body-source'
