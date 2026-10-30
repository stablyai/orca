import { snapshotResult, releaseGate } from './preview-terminal-snapshot'
import {
  createPreviewInputBinding,
  type PreviewSession,
  type PreviewInputBinding
} from './preview-terminal-input-source'
import { createPreviewTerminalSessionLifetime } from './preview-terminal-session-lifetime'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import type {
  TerminalPreviewConnectResult,
  TerminalPreviewDataPayload
} from '../../../../shared/terminal-preview'

type TerminalPreviewApi = typeof window.api.terminalPreview

const SNAPSHOT_RETRY_ATTEMPTS = 3
const SNAPSHOT_RETRY_DELAY_MS = 150
const UNAVAILABLE: TerminalPreviewConnectResult = { snapshot: null, replay: [] }

const sessions = new Map<string, PreviewSession>()
const listeners = new Set<(payload: TerminalPreviewDataPayload) => void>()

function emit(payload: TerminalPreviewDataPayload): void {
  for (const listener of listeners) {
    listener(payload)
  }
}

const { openSession, closeSession } = createPreviewTerminalSessionLifetime(sessions, emit)

async function refreshSession(
  ptyId: string,
  session: PreviewSession,
  scrollbackRows: number | undefined,
  binding?: PreviewInputBinding
): Promise<TerminalPreviewConnectResult> {
  const stream = session.stream
  if (!stream) {
    return UNAVAILABLE
  }
  for (const binding of Array.from(session.bindings)) {
    binding.invalidate()
  }
  if (
    session.closed ||
    session.ended ||
    sessions.get(ptyId) !== session ||
    session.stream !== stream
  ) {
    return UNAVAILABLE
  }
  session.gate = []
  for (let attempt = 0; attempt < SNAPSHOT_RETRY_ATTEMPTS; attempt++) {
    const outcome = await stream.serializeBufferOutcome({ scrollbackRows }).catch(() => null)
    if (session.closed || session.ended) {
      return UNAVAILABLE
    }
    if (sessions.get(ptyId) !== session) {
      // The transport dropped mid-request; reopen rather than report the pane gone.
      return connectPreview(ptyId, { scrollbackRows }, binding)
    }
    const snapshot = outcome?.snapshot
    if (snapshot) {
      const replay = releaseGate(session, snapshot.seq)
      if (
        session.closed ||
        session.ended ||
        sessions.get(ptyId) !== session ||
        session.stream !== stream
      ) {
        return UNAVAILABLE
      }
      return snapshotResult(session, snapshot.data, snapshot, replay)
    }
    if (outcome?.availability.kind !== 'retry-worthy') {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_RETRY_DELAY_MS))
  }
  const held = session.gate?.splice(0) ?? []
  session.gate = null
  let failure: unknown
  for (const chunk of held) {
    try {
      chunk.release()
    } catch (error) {
      failure ??= error
    }
  }
  if (failure !== undefined) {
    throw failure
  }
  return UNAVAILABLE
}

function connectPreview(
  ptyId: string,
  opts?: Parameters<TerminalPreviewApi['connect']>[1],
  binding?: PreviewInputBinding
): Promise<TerminalPreviewConnectResult> {
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
  if (existing) {
    binding?.attach(existing)
  }
  if (existing?.opening) {
    return existing.opening
  }
  if (existing) {
    return refreshSession(ptyId, existing, opts?.scrollbackRows, binding)
  }
  return openSession(ptyId, parts.environmentId, parts.handle, binding)
}

/** Reuse pane multiplexing: the owning paired host serializes snapshots and holds the live-output boundary. */
export const remoteRuntimeTerminalPreviewApi: TerminalPreviewApi = {
  connect: connectPreview,
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

/** The renderer binding keeps endpoint proof when its recoverable session leaves the map. */
export function bindRemoteRuntimeTerminalPreview(ptyId: string) {
  const binding = createPreviewInputBinding(ptyId)
  return {
    ...remoteRuntimeTerminalPreviewApi,
    getInputSource: binding.source.current,
    observeInputSource: binding.source.observe,
    connect: (id: string, opts?: Parameters<TerminalPreviewApi['connect']>[1]) =>
      connectPreview(id, opts, binding),
    unsubscribe: async (id: string) => {
      const session = sessions.get(id)
      if (binding.dispose() && session) {
        closeSession(id, session)
      }
    }
  }
}
