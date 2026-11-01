import { useEffect, useState } from 'react'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '@/components/editor/editor-autosave'
import { editorSavedEventView } from '@/components/editor/editor-saved-event-view'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
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
  ) => void,
  fresh: boolean
): Promise<void> {
  for (let retry = 0; ; retry += 1) {
    const outcome = await readNativeChatVisual(identity, { fresh })
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

/** How many times the editor has saved the visual's file on the chat's own host. */
function useEditorSavesOf(target: RuntimeClientTarget, path: string | null): number {
  const [saves, setSaves] = useState(0)
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  useEffect(() => {
    if (!path) {
      return
    }
    const onSaved = (event: Event): void => {
      const state = useAppStore.getState()
      const file = editorSavedEventView(
        state.openFiles,
        event instanceof CustomEvent ? event.detail : null
      )
      // Same path on another host is another file.
      const owner =
        file?.filePath === path
          ? getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
          : null
      if (owner && (owner.kind === 'environment' ? owner.environmentId : null) === environmentId) {
        setSaves((count) => count + 1)
      }
    }
    window.addEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
    return () => window.removeEventListener(ORCA_EDITOR_FILE_SAVED_EVENT, onSaved)
  }, [environmentId, path])
  return saves
}

/** Revalidate cached visuals when enabled and after editor saves on their host; keep shown documents through contact failures. */
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
  const saves = useEditorSavesOf(
    identity.target,
    state.status === 'ready' ? state.document.path : null
  )

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
    void loadWithRetries(identityNow, abort.signal, setState, saves > 0)
    return () => abort.abort()
  }, [enabled, environmentId, file, sessionId, saves])

  return state
}
