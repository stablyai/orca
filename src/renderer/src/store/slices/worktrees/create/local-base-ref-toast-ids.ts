import { toast } from 'sonner'

export type LocalBaseRefToastVariant = 'shallow' | 'refresh'

// Why 1s: sonner removes a closed toast by id ~200ms after close (plus a frame), so an id is unsafe until then.
const RETIRED_ID_QUARANTINE_MS = 1000

type TargetToasts = {
  shown?: { id: string; variant: LocalBaseRefToastVariant }
  retiredAt: Map<string, number>
}

const toastsByTarget = new Map<string, TargetToasts>()

function pruneRetired(now: number): void {
  for (const [key, target] of toastsByTarget) {
    for (const [id, at] of target.retiredAt) {
      if (now - at > RETIRED_ID_QUARANTINE_MS) {
        target.retiredAt.delete(id)
      }
    }
    if (!target.shown && target.retiredAt.size === 0) {
      toastsByTarget.delete(key)
    }
  }
}

function targetFor(key: string): TargetToasts {
  const target = toastsByTarget.get(key) ?? { retiredAt: new Map<string, number>() }
  toastsByTarget.set(key, target)
  return target
}

function retire(key: string, id: string): void {
  const target = targetFor(key)
  target.retiredAt.set(id, Date.now())
  if (target.shown?.id === id) {
    target.shown = undefined
  }
}

/**
 * One toast per target. A repeat of the shown variant updates it in place; anything else retires it
 * and takes the lowest slot id not closed within the quarantine, so a pending removal can't hit the
 * new toast and ids (and sonner's history) stay bounded.
 */
export function claimLocalBaseRefToastId(
  key: string,
  variant: LocalBaseRefToastVariant
): { id: string; onDismiss: () => void } {
  const now = Date.now()
  pruneRetired(now)
  const target = targetFor(key)
  const onDismissFor = (id: string) => (): void => retire(key, id)

  const shown = target.shown
  if (shown && toast.getToasts().some((entry) => entry.id === shown.id)) {
    if (shown.variant === variant) {
      return { id: shown.id, onDismiss: onDismissFor(shown.id) }
    }
    toast.dismiss(shown.id)
  }
  if (shown) {
    retire(key, shown.id)
  }
  // Why per variant: sonner merges an update into an id's old fields, so a slot never switches variant.
  let slot = 0
  while (target.retiredAt.has(`${key}:${variant}:${slot}`)) {
    slot++
  }
  const id = `${key}:${variant}:${slot}`
  target.shown = { id, variant }
  return { id, onDismiss: onDismissFor(id) }
}
