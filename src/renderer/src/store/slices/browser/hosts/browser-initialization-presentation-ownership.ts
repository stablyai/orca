import type { RemoteBrowserPageHandle } from '../browser-slice-contract'
import type { BrowserInitializationDelivery } from '@/runtime/web-session-tabs-sync/browser-initialization-presentation'

type Handles = Record<string, RemoteBrowserPageHandle>
type HandleWrite = Set<string> | 'hydration'
const writes = new WeakMap<Handles, HandleWrite>()

export function annotateBrowserPageHandles(
  next: Handles,
  changedIds: Iterable<string>,
  previous?: Handles
): Handles {
  if (next === previous) {
    return next
  }
  const carried = previous && writes.get(previous)
  let changed = writes.get(next)
  if (!changed) {
    changed = carried === 'hydration' ? 'hydration' : new Set(carried)
    writes.set(next, changed)
  }
  if (changed !== 'hydration') {
    if (carried === 'hydration') {
      writes.set(next, 'hydration')
      return next
    }
    if (carried && carried !== changed) {
      for (const id of carried) {
        changed.add(id)
      }
    }
    for (const id of changedIds) {
      changed.add(id)
    }
  }
  return next
}

export function copyBrowserPageHandles(
  previous: Handles,
  changedIds: Iterable<string> = []
): Handles {
  return annotateBrowserPageHandles({ ...previous }, changedIds, previous)
}

export function markHydratedBrowserPageHandles(handles: Handles): Handles {
  writes.set(handles, 'hydration')
  return handles
}

function contribution(
  handle: RemoteBrowserPageHandle | undefined
): BrowserInitializationDelivery | undefined {
  const presentation = handle?.initializationPresentation
  return presentation?.delivery.live &&
    presentation.delivery.environmentId === handle?.environmentId &&
    presentation.disposition !== 'unavailable'
    ? presentation.delivery
    : undefined
}

export function commitBrowserPageHandleOwnership(
  previous: Handles,
  next: Handles,
  checkInvariant: boolean,
  nestedIds?: ReadonlySet<string>
): ReadonlySet<string> | undefined {
  if (previous === next) {
    return
  }
  const write = writes.get(next)
  if (!write) {
    if (checkInvariant) {
      throw new Error('Browser page handle write is missing changed page IDs')
    }
    return
  }
  const ids =
    write === 'hydration'
      ? new Set([...Object.keys(previous), ...Object.keys(next)])
      : nestedIds?.size
        ? new Set(write)
        : write
  if (nestedIds) {
    for (const id of nestedIds) {
      ids.add(id)
    }
  }
  const deltas = new Map<BrowserInitializationDelivery, number>()
  for (const id of ids) {
    const before = contribution(previous[id])
    const after = contribution(next[id])
    if (before === after) {
      continue
    }
    if (before) {
      deltas.set(before, (deltas.get(before) ?? 0) - 1)
    }
    if (after) {
      deltas.set(after, (deltas.get(after) ?? 0) + 1)
    }
  }
  for (const [delivery, delta] of deltas) {
    if (delivery.publishedPresentationCount + delta < 0) {
      throw new Error('Browser page presentation ownership became negative')
    }
  }
  for (const [delivery, delta] of deltas) {
    delivery.publishedPresentationCount += delta
  }
  writes.delete(next)
  return ids
}
