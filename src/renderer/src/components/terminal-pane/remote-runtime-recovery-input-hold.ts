import type { TerminalInputKind } from '../../../../shared/terminal-input-kind'
import {
  createPtyPreconnectInputBuffer,
  type PtyPreconnectInputBuffer
} from './pty-preconnect-input-buffer'

/** The remote terminal a held keystroke was typed into. */
export type RemoteRuntimeInputEndpoint = {
  handle: string
  incarnationId: string | null
}

type HeldInputWriter = {
  isCurrent: () => boolean
  sendInput: (data: string, inputKind: TerminalInputKind) => boolean
  sendInputImmediate: (data: string) => boolean
  sendInputAccepted: (data: string, inputKind: TerminalInputKind) => Promise<boolean>
}

export type RemoteRuntimeRecoveryInputHold = {
  isHolding: () => boolean
  enqueue: (
    endpoint: RemoteRuntimeInputEndpoint,
    data: string,
    inputKind: TerminalInputKind
  ) => boolean
  enqueueAccepted: (
    endpoint: RemoteRuntimeInputEndpoint,
    data: string,
    inputKind: TerminalInputKind
  ) => Promise<boolean>
  /** Delivers held input to the endpoint it was typed into, or drops it if the pane rebound elsewhere. */
  release: (bound: RemoteRuntimeInputEndpoint, writer: HeldInputWriter) => void
  discard: () => void
}

function isSameEndpoint(
  held: RemoteRuntimeInputEndpoint,
  bound: RemoteRuntimeInputEndpoint
): boolean {
  // Why: an incarnation learned only after the hold began is not evidence of a respawn.
  return (
    held.handle === bound.handle &&
    (held.incarnationId === null ||
      bound.incarnationId === null ||
      held.incarnationId === bound.incarnationId)
  )
}

/** Keeps keystrokes typed while a remote pane is binding or recovering, scoped to one endpoint. */
export function createRemoteRuntimeRecoveryInputHold(): RemoteRuntimeRecoveryInputHold {
  let held: {
    endpoint: RemoteRuntimeInputEndpoint
    buffer: PtyPreconnectInputBuffer
  } | null = null

  const discard = (): void => {
    const current = held
    held = null
    current?.buffer.clear()
  }

  const bufferFor = (endpoint: RemoteRuntimeInputEndpoint): PtyPreconnectInputBuffer => {
    if (held && !isSameEndpoint(held.endpoint, endpoint)) {
      // Why: input typed at one shell must never run in its replacement (#10065).
      discard()
    }
    if (!held?.buffer.isBuffering()) {
      // Why: a drained buffer refuses input; its release bookkeeping may still be settling.
      held = { endpoint, buffer: createPtyPreconnectInputBuffer() }
    }
    return held.buffer
  }

  return {
    isHolding: () => held?.buffer.isBuffering() === true,
    enqueue: (endpoint, data, inputKind) =>
      bufferFor(endpoint).enqueue(data, 'ordinary', inputKind),
    enqueueAccepted: (endpoint, data, inputKind) =>
      bufferFor(endpoint).enqueueAccepted(data, inputKind),
    release(bound, writer) {
      const current = held
      if (!current) {
        return
      }
      if (!isSameEndpoint(current.endpoint, bound)) {
        discard()
        return
      }
      void current.buffer
        .flush({
          ...writer,
          isCurrent: () => held === current && writer.isCurrent()
        })
        .catch(() => undefined)
        .finally(() => {
          if (held === current && !current.buffer.isBuffering()) {
            held = null
          }
        })
    },
    discard
  }
}
