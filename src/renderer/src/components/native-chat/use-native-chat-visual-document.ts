import { useEffect, useState } from 'react'
import {
  isRetryableNativeChatVisualFailure,
  peekCachedNativeChatVisual,
  readNativeChatVisual,
  type NativeChatVisualDocument,
  type NativeChatVisualIdentity
} from './native-chat-visual-read-client'

export type NativeChatVisualDocumentState =
  | { status: 'loading' }
  | { status: 'ready'; document: NativeChatVisualDocument }
  | { status: 'unavailable' }

/** Waits before each retry of a read that may yet succeed; bounded, then the failure shows. */
export const NATIVE_CHAT_VISUAL_RETRY_DELAYS_MS = [1_500, 4_000, 10_000] as const

function waitFor(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(!signal.aborted), ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve(false)
      },
      { once: true }
    )
  })
}

async function loadWithRetries(
  identity: NativeChatVisualIdentity,
  signal: AbortSignal,
  setState: (
    update: (shown: NativeChatVisualDocumentState) => NativeChatVisualDocumentState
  ) => void
): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    const outcome = await readNativeChatVisual(identity)
    if (signal.aborted) {
      return
    }
    if (outcome.ok) {
      setState((shown) =>
        shown.status === 'ready' && shown.document.revision === outcome.document.revision
          ? shown
          : { status: 'ready', document: outcome.document }
      )
      return
    }
    const delay = NATIVE_CHAT_VISUAL_RETRY_DELAYS_MS[retry]
    if (!isRetryableNativeChatVisualFailure(outcome.reason) || delay === undefined) {
      // Why keep a shown document on `unavailable`: losing contact says nothing about the file.
      setState((shown) =>
        shown.status === 'ready' && outcome.reason === 'unavailable'
          ? shown
          : { status: 'unavailable' }
      )
      return
    }
    if (!(await waitFor(delay, signal))) {
      return
    }
  }
}

/**
 * The visual's current document. Starts from the cached revision when there is one, then asks the
 * host (revalidating it) once `enabled`. A later failure keeps a document already shown.
 */
export function useNativeChatVisualDocument(
  identity: NativeChatVisualIdentity,
  enabled: boolean
): NativeChatVisualDocumentState {
  const { sessionId, file } = identity
  const environmentId =
    identity.target.kind === 'environment' ? identity.target.environmentId : null
  const [state, setState] = useState<NativeChatVisualDocumentState>(() => {
    const cached = peekCachedNativeChatVisual(identity)
    return cached ? { status: 'ready', document: cached } : { status: 'loading' }
  })

  useEffect(() => {
    if (!enabled) {
      return
    }
    const identityNow: NativeChatVisualIdentity = {
      target: environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
      sessionId,
      file
    }
    const abort = new AbortController()
    void loadWithRetries(identityNow, abort.signal, setState)
    return () => abort.abort()
  }, [enabled, environmentId, file, sessionId])

  return state
}
