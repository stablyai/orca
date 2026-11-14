import { cancelPendingEditorLineRevealFrames } from '@/store/slices/editor/focus/editor-focus-reveal'

let latestRequestId = 0
const listeners = new Set<() => void>()

export function subscribeLinkOpenRequests(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** All link surfaces supersede pending opens and line reveals together. */
export function beginLinkOpenRequest(): () => boolean {
  const requestId = ++latestRequestId
  cancelPendingEditorLineRevealFrames()
  for (const listener of listeners) {
    listener()
  }
  return () => requestId === latestRequestId
}
