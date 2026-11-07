import { RemoteRuntimeClientError } from '../remote-runtime-client-error'
import type { PairedE2EEChannel } from '../e2ee/paired-e2ee-client-handshake'

// Local only, never part of a frame: who needs to know when a request's own frame actually leaves.
const observers = new WeakMap<object, () => void>()

/** A request that may not leave this process after `end` (this machine's clock): its frame is
 *  refused at the handoff once the end passed, and carries only the time left when it goes. */
export type RemoteRuntimeRequestDispatchLimit = {
  end: number
  /** The params to send with `remainingMs` left; absent when the request carries no budget. */
  withRemaining?: (params: unknown, remainingMs: number) => unknown
  /** The frame left: from here only the host's answer remains, which the end never cuts. */
  handedOff: () => void
}

const limits = new WeakMap<object, RemoteRuntimeRequestDispatchLimit>()

/** `onDispatched` runs when a frame carrying exactly this params object is handed to its socket,
 *  after admission, serialization and sealing: never for status, authentication or a request
 *  that ended before it was sent. */
export function observeRemoteRuntimeRequestDispatch(
  params: unknown,
  onDispatched: () => void
): void {
  if (typeof params === 'object' && params !== null) {
    observers.set(params, onDispatched)
  }
}

export function limitRemoteRuntimeRequestDispatch(
  params: unknown,
  limit: RemoteRuntimeRequestDispatchLimit
): void {
  if (typeof params === 'object' && params !== null) {
    limits.set(params, limit)
  }
}

/** Read where a request is created, to call at its frame's handoff. Notification only: what an
 *  observer throws never reaches the send. */
export function remoteRuntimeRequestDispatchObserver(params: unknown): (() => void) | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined
  }
  const observer = observers.get(params)
  const limit = limits.get(params)
  if (!observer && !limit) {
    return undefined
  }
  return () => {
    for (const notify of [limit?.handedOff, observer]) {
      try {
        notify?.()
      } catch {
        // Bookkeeping only.
      }
    }
  }
}

/** Read where a request is created, for its channel to run as the seal's final admission: throws
 *  once the request's end passed, before the frame spends any sequence or leaves the channel.
 *  Separate from the observer, which never gates a send. */
export function remoteRuntimeRequestDispatchCutoff(params: unknown): (() => void) | undefined {
  const limit = typeof params === 'object' && params !== null ? limits.get(params) : undefined
  if (!limit) {
    return undefined
  }
  return () => {
    if (Math.floor(limit.end - Date.now()) < 1) {
      throw remoteRuntimeRequestDispatchExpiredError()
    }
  }
}

/** What to serialize at the frame's actual handoff, just before it is sealed and sent: the same
 *  params, or a copy carrying only the time left. Null when the request's end passed, so it
 *  must not be sent at all. */
export function remoteRuntimeRequestParamsAtHandoff(params: unknown): { params: unknown } | null {
  const limit = typeof params === 'object' && params !== null ? limits.get(params) : undefined
  if (!limit) {
    return { params }
  }
  const remainingMs = Math.floor(limit.end - Date.now())
  if (remainingMs < 1) {
    return null
  }
  return { params: limit.withRemaining ? limit.withRemaining(params, remainingMs) : params }
}

/** Seals with `assertInTime` as the channel's final admission. Its refusal comes back as
 *  `expired`, apart from a failure of the seal itself, which propagates. */
export function sealRemoteRuntimeRequest(
  channel: PairedE2EEChannel,
  text: string,
  assertInTime: (() => void) | undefined
): { frame: string } | { expired: unknown } {
  const admission: { refused: boolean; error?: unknown } = { refused: false }
  const admit =
    assertInTime &&
    (() => {
      try {
        assertInTime()
      } catch (error) {
        admission.refused = true
        admission.error = error
        throw error
      }
    })
  try {
    return { frame: channel.sealText(text, admit) }
  } catch (error) {
    if (admission.refused) {
      return { expired: admission.error }
    }
    throw error
  }
}

export function remoteRuntimeRequestDispatchExpiredError(): RemoteRuntimeClientError {
  return new RemoteRuntimeClientError(
    'runtime_timeout',
    'The request ran out of time before it was sent to the remote Orca runtime.'
  )
}
