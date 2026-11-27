import { toast } from 'sonner'

// Why: while a target's toast is open, a newer result updates it in place (nothing is queued against an
// open id, so there is nothing to race). Every close path retires the id first and for good, since sonner
// may still act on it (exit timer, dismissal frames); the next result then gets a never-used id.
// Results never grow sonner's history; each closed notice keeps one entry, like any other toast.
const openToastIds = new Map<string, string>()
let toastGeneration = 0

/** The open toast's id for this target, or a fresh one; render with it. */
export function openLocalBaseRefToastId(target: string): string {
  const open = openToastIds.get(target)
  if (open) {
    return open
  }
  const id = `${target}:${++toastGeneration}`
  openToastIds.set(target, id)
  return id
}

export function isLocalBaseRefToastOpen(target: string, id: string): boolean {
  return openToastIds.get(target) === id
}

/** Every close path calls this before sonner acts: sonner's onDismiss (close button, swipe) and our dismissals. */
export function retireLocalBaseRefToast(target: string, id: string): void {
  if (openToastIds.get(target) === id) {
    openToastIds.delete(target)
  }
}

export function dismissLocalBaseRefToast(target: string, id: string): void {
  retireLocalBaseRefToast(target, id)
  toast.dismiss(id)
}
