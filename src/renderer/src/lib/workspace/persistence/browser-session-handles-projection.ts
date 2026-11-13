import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'

type Handles = Record<string, RemoteBrowserPageHandle>

function sameSessionHandle(
  previous: RemoteBrowserPageHandle,
  next: RemoteBrowserPageHandle
): boolean {
  if (previous === next) {
    return true
  }
  const previousFields: Record<string, unknown> = previous
  const nextFields: Record<string, unknown> = next
  for (const key of new Set([...Object.keys(previousFields), ...Object.keys(nextFields)])) {
    if (key !== 'initializationPresentation' && previousFields[key] !== nextFields[key]) {
      return false
    }
  }
  return true
}

function sameSessionHandles(previous: Handles, next: Handles): boolean {
  if (Object.keys(previous).length !== Object.keys(next).length) {
    return false
  }
  for (const id in next) {
    if (Object.hasOwn(next, id) && (!previous[id] || !sameSessionHandle(previous[id], next[id]))) {
      return false
    }
  }
  return true
}

export function createBrowserSessionHandlesProjection(): (source: Handles) => Handles {
  let source: Handles | undefined
  let projected: Handles = {}
  return (next) => {
    if (source !== next) {
      source = next
      if (!sameSessionHandles(projected, next)) {
        projected = next
      }
    }
    return projected
  }
}
