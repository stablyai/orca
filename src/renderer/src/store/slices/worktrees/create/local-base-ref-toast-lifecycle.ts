import { toast } from 'sonner'

// Why: while a target's toast is open, a newer result updates it in place (nothing is queued against an
// open id, so there is nothing to race). Every close path retires the id first and for good, since sonner
// may still act on it (exit timer, dismissal frames); the next result then gets a never-used id.
// Results never grow sonner's history, and a retired id's entry is pruned, since sonner never drops one.
// The latest result's render is kept so a late re-render (e.g. a resize) can't republish an older result.
const openToasts = new Map<string, { id: string; render: () => void }>()
let toastGeneration = 0

/** The open toast's id for this target, or a fresh one; pass it to renderLocalBaseRefToast. */
export function openLocalBaseRefToastId(target: string): string {
  const open = openToasts.get(target)
  if (open) {
    return open.id
  }
  const id = `${target}:${++toastGeneration}`
  openToasts.set(target, { id, render: () => {} })
  return id
}

/** Shows the latest result in the open toast and remembers it for later re-renders. */
export function renderLocalBaseRefToast(target: string, id: string, render: () => void): void {
  const open = openToasts.get(target)
  if (open?.id === id) {
    open.render = render
    render()
  }
}

/** True while the open toast still shows the result this render belongs to. */
export function isLocalBaseRefToastShowing(
  target: string,
  id: string,
  render: () => void
): boolean {
  const open = openToasts.get(target)
  return open?.id === id && open.render === render
}

/** Re-renders the open toast with its latest result, never the caller's. */
export function rerenderLocalBaseRefToast(target: string, id: string): void {
  const open = openToasts.get(target)
  if (open?.id === id) {
    open.render()
  }
}

/** Every close path calls this before sonner acts: sonner's onDismiss (close button, swipe) and our dismissals. */
export function retireLocalBaseRefToast(target: string, id: string): void {
  if (openToasts.get(target)?.id === id) {
    openToasts.delete(target)
    pruneRetiredToastFromHistory(id)
  }
}

// Why safe: sonner reads history to find an id we create again, to list active toasts (dismissed ids are
// already filtered out) or to dismiss all; a retired id is never created again and is already closing.
// Its rendered copy lives in the Toaster's own state. Searched from the newest end, where our entry usually is.
function pruneRetiredToastFromHistory(id: string): void {
  const history = toast.getHistory()
  const index = history.findLastIndex((entry) => entry.id === id)
  if (index !== -1) {
    history.splice(index, 1)
  }
}

export function dismissLocalBaseRefToast(target: string, id: string): void {
  retireLocalBaseRefToast(target, id)
  toast.dismiss(id)
}
