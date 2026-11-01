import type { BundledSkillTarget } from '@/lib/bundled-skill-target'

type SkillFreshnessUpdateDialogRequest = { target?: BundledSkillTarget | null }

let pendingOpen: SkillFreshnessUpdateDialogRequest | null = null
const listeners = new Set<() => void>()

// Retain requests as an external snapshot so a nudge action cannot race dialog subscription.
export function requestSkillFreshnessUpdateDialog(target?: BundledSkillTarget | null): void {
  pendingOpen = { target }
  for (const listener of listeners) {
    listener()
  }
}

export function consumeSkillFreshnessUpdateDialogRequest(): boolean {
  const requested = pendingOpen !== null
  pendingOpen = null
  if (requested) {
    for (const listener of listeners) {
      listener()
    }
  }
  return requested
}

export function getSkillFreshnessUpdateDialogRequest(): boolean {
  return pendingOpen !== null
}

export function getSkillFreshnessUpdateDialogOpenRequest(): SkillFreshnessUpdateDialogRequest | null {
  return pendingOpen
}

export function subscribeSkillFreshnessUpdateDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
