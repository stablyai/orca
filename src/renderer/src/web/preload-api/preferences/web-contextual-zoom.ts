import type { UIZoomDirection } from '../../../../../shared/app-lifecycle/windows/ui-zoom-level'

const listeners = new Set<(direction: UIZoomDirection) => void>()

export function subscribeWebContextualZoom(
  listener: (direction: UIZoomDirection) => void
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishWebContextualZoom(direction: UIZoomDirection): void {
  for (const listener of listeners) {
    listener(direction)
  }
}
