import { createBrowserUuid } from '@/lib/browser-uuid'
import { takeCurrentTerminalDeliveryCredit } from '@/lib/pane-manager/terminal-delivery-credit'
import {
  getRemoteRuntimeTerminalMultiplexer,
  type RemoteRuntimeMultiplexedTerminal,
  type RemoteRuntimeMultiplexedTerminalCallbacks
} from '@/runtime/remote-runtime-terminal-multiplexer'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload,
  TerminalPreviewReplayChunk
} from '../../../../shared/terminal-preview'

type TerminalPreviewApi = typeof window.api.terminalPreview

const CONNECT_TIMEOUT_MS = 15_000
const SNAPSHOT_RETRY_ATTEMPTS = 3
const SNAPSHOT_RETRY_DELAY_MS = 150
const FALLBACK_COLS = 80
const FALLBACK_ROWS = 24
const UNAVAILABLE: TerminalPreviewConnectResult = { snapshot: null, replay: [] }

type SnapshotMeta = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onSnapshot']>[1]
type OutputMeta = Parameters<RemoteRuntimeMultiplexedTerminalCallbacks['onData']>[1]
type HeldChunk = { data: string; meta: OutputMeta; release: () => void }

type PreviewSession = {
  stream: RemoteRuntimeMultiplexedTerminal | null
  /** The pending first connect; a refresh issued before it lands shares it. */
  opening: Promise<TerminalPreviewConnectResult> | null
  /** The host ended the stream; the pane is gone or unreachable, never "exited" by guess. */
  ended: boolean
  closed: boolean
  /** Live chunks held while a snapshot is in flight, so the boundary can drop covered bytes. */
  gate: HeldChunk[] | null
  /** Output high-water of the applied snapshot; a tagged request still forwards covered chunks. */
  snapshotSeq: number | undefined
  /** Transport credit per emitted chunk, returned in order as the preview parses them. */
  credits: (() => void)[]
  grid: { cols: number; rows: number } | null
}

const sessions = new Map<string, PreviewSession>()
const listeners = new Set<(payload: TerminalPreviewDataPayload) => void>()

function emit(payload: TerminalPreviewDataPayload): void {
  for (const listener of listeners) {
    listener(payload)
  }
}

function snapshotResult(
  session: PreviewSession,
  data: string,
  meta: SnapshotMeta,
  replay: TerminalPreviewReplayChunk[]
): TerminalPreviewConnectResult {
  session.grid =
    typeof meta?.cols === 'number' && typeof meta.rows === 'number'
      ? { cols: meta.cols, rows: meta.rows }
      : null
  return {
    snapshot: {
      data,
      // Why: hosts that omit dims serialized at the PTY grid; the box fit and claim correct it.
      cols: meta?.cols ?? FALLBACK_COLS,
      rows: meta?.rows ?? FALLBACK_ROWS,
      seq: meta?.seq,
      pendingEscapeTailAnsi: meta?.pendingEscapeTailAnsi,
      kittyKeyboardFlags: meta?.kittyKeyboardFlags
    },
    replay
  }
}

/** The part of a chunk the snapshot at `snapshotSeq` does not already contain. */
function outputAfterSnapshot(
  data: string,
  meta: OutputMeta,
  snapshotSeq: number | undefined
): string | null {
  const seq = meta?.seq
  const rawLength = meta?.rawLength ?? (meta?.transformed ? undefined : data.length)
  if (snapshotSeq === undefined || seq === undefined || rawLength === undefined) {
    return data
  }
  if (seq <= snapshotSeq) {
    return null
  }
  const start = seq - rawLength
  if (start >= snapshotSeq) {
    return data
  }
  // A transformed span cannot be split by offset; the host drops it on the same boundary.
  return meta?.transformed ? null : data.slice(snapshotSeq - start)
}

// Why: chunks flushed before a requested snapshot carry no proof of order without a seq.
function releaseGate(session: PreviewSession, snapshotSeq: number | undefined) {
  const held = session.gate ?? []
  session.gate = null
  session.snapshotSeq = snapshotSeq
  const replay: TerminalPreviewReplayChunk[] = []
  for (const chunk of held) {
    const data =
      chunk.meta?.seq === undefined
        ? null
        : outputAfterSnapshot(chunk.data, chunk.meta, snapshotSeq)
    if (data) {
      replay.push({ data, mode: 'live' })
    }
    chunk.release()
  }
  return replay
}

function releaseCredits(session: PreviewSession): void {
  for (const release of session.credits.splice(0)) {
    release()
  }
  for (const chunk of session.gate?.splice(0) ?? []) {
    chunk.release()
  }
}

function closeSession(ptyId: string, session: PreviewSession): void {
  session.closed = true
  releaseCredits(session)
  session.stream?.close()
  session.stream = null
  if (sessions.get(ptyId) === session) {
    sessions.delete(ptyId)
  }
}

function openSession(ptyId: string, environmentId: string, handle: string) {
  const session: PreviewSession = {
    stream: null,
    opening: null,
    ended: false,
    closed: false,
    gate: [],
    snapshotSeq: undefined,
    credits: [],
    grid: null
  }
  sessions.set(ptyId, session)
  let initialized = false
  const opening = new Promise<TerminalPreviewConnectResult>((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      closeSession(ptyId, session)
      finish(UNAVAILABLE)
    }, CONNECT_TIMEOUT_MS)
    function finish(result: TerminalPreviewConnectResult): void {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        session.opening = null
        resolve(result)
      }
    }
    const markEnded = (): void => {
      session.ended = true
      finish(UNAVAILABLE)
      if (initialized && !session.closed) {
        emit({ type: 'resync', ptyId })
      }
    }
    void getRemoteRuntimeTerminalMultiplexer(environmentId)
      .subscribeTerminal({
        terminal: handle,
        // Why a preview-only id: its viewport claim must release with this stream, not a pane's.
        client: { id: `dashboard-preview:${createBrowserUuid()}`, type: 'desktop' },
        callbacks: {
          onSnapshot: (data, meta) => {
            if (initialized) {
              // A host-pushed recovery image follows dropped output; repaint through a fresh request.
              emit({ type: 'resync', ptyId })
              return
            }
            initialized = true
            finish(snapshotResult(session, data, meta, releaseGate(session, meta?.seq)))
          },
          onData: (data, meta) => {
            if (session.closed) {
              return
            }
            const noCredit = (): void => {}
            if (session.gate) {
              session.gate.push({
                data,
                meta,
                release: takeCurrentTerminalDeliveryCredit() ?? noCredit
              })
              return
            }
            const uncovered = outputAfterSnapshot(data, meta, session.snapshotSeq)
            if (uncovered) {
              // Why: hold the host's credit until the preview parses the chunk, like a pane does.
              session.credits.push(takeCurrentTerminalDeliveryCredit() ?? noCredit)
              emit({ type: 'data', ptyId, data: uncovered, bytes: uncovered.length })
            }
          },
          onFitOverrideChanged: (event) => {
            if (event.cols !== session.grid?.cols || event.rows !== session.grid?.rows) {
              emit({ type: 'resync', ptyId })
            }
          },
          onEnd: markEnded,
          onError: markEnded,
          onTransportClose: () => {
            // Why: loss of contact is not pane death — drop the session so a resync reopens it.
            if (sessions.get(ptyId) === session) {
              sessions.delete(ptyId)
            }
            session.stream = null
            releaseCredits(session)
            finish(UNAVAILABLE)
            if (initialized && !session.closed) {
              emit({ type: 'resync', ptyId })
            }
          }
        }
      })
      .then(
        (stream) => {
          if (session.closed) {
            stream.close()
            return
          }
          session.stream = stream
        },
        () => {
          closeSession(ptyId, session)
          finish(UNAVAILABLE)
        }
      )
  })
  session.opening = opening
  return opening
}

async function refreshSession(
  ptyId: string,
  session: PreviewSession,
  scrollbackRows: number | undefined
): Promise<TerminalPreviewConnectResult> {
  const stream = session.stream
  if (!stream) {
    return UNAVAILABLE
  }
  session.gate = []
  for (let attempt = 0; attempt < SNAPSHOT_RETRY_ATTEMPTS; attempt++) {
    const outcome = await stream.serializeBufferOutcome({ scrollbackRows }).catch(() => null)
    if (session.closed) {
      return UNAVAILABLE
    }
    if (sessions.get(ptyId) !== session) {
      // The transport dropped mid-request; reopen rather than report the pane gone.
      return remoteRuntimeTerminalPreviewApi.connect(ptyId, { scrollbackRows })
    }
    const snapshot = outcome?.snapshot
    if (snapshot) {
      return snapshotResult(session, snapshot.data, snapshot, releaseGate(session, snapshot.seq))
    }
    if (outcome?.availability.kind !== 'retry-worthy') {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RETRY_DELAY_MS))
  }
  for (const chunk of session.gate?.splice(0) ?? []) {
    chunk.release()
  }
  session.gate = null
  return UNAVAILABLE
}

/**
 * Dashboard preview of a paired host's terminal over the same multiplexed stream panes use:
 * the owning host serializes the snapshot and holds the live boundary, so any host that serves
 * panes also serves previews.
 */
export const remoteRuntimeTerminalPreviewApi: TerminalPreviewApi = {
  connect: (ptyId, opts) => {
    const parts = parseRemoteRuntimePtyId(ptyId)
    // Why: an id without its owner cannot be routed; guessing the active server could show another host's pane.
    if (!parts?.environmentId) {
      return Promise.resolve(UNAVAILABLE)
    }
    const existing = sessions.get(ptyId)
    if (existing?.ended) {
      closeSession(ptyId, existing)
      return Promise.resolve(UNAVAILABLE)
    }
    if (existing?.opening) {
      return existing.opening
    }
    if (existing) {
      return refreshSession(ptyId, existing, opts?.scrollbackRows)
    }
    return openSession(ptyId, parts.environmentId, parts.handle)
  },
  input: (ptyId, data) => Promise.resolve(sessions.get(ptyId)?.stream?.sendInput(data) ?? false),
  fit: (ptyId, cols, rows) => {
    // Why: the host answers the claim with a fit-override event, which triggers the resync repaint.
    const claimed = sessions.get(ptyId)?.stream?.claimViewport(cols, rows) ?? false
    return Promise.resolve(claimed ? { cols, rows } : null)
  },
  // Why in order: the preview acknowledges chunks as xterm parses them, which is emit order.
  ack: (ptyId) => {
    sessions.get(ptyId)?.credits.shift()?.()
    return Promise.resolve()
  },
  unsubscribe: (ptyId) => {
    const session = sessions.get(ptyId)
    if (session) {
      closeSession(ptyId, session)
    }
    return Promise.resolve()
  },
  onData: (callback) => {
    listeners.add(callback)
    return () => listeners.delete(callback)
  }
}

export function resetRemoteRuntimeTerminalPreviewSessionsForTests(): void {
  for (const [ptyId, session] of sessions) {
    closeSession(ptyId, session)
  }
  listeners.clear()
}
