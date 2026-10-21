import type { ExecutionHostId } from '../../../shared/execution-host'

// Why: a selection cleared by a process exit is automatic, so the removal that follows may still
// hand off; a selection the user cleared (last tab closed, a deselect) must stay cleared.
let automaticDeselectionDepth = 0

export function runAsAutomaticDeselection<T>(clear: () => T): T {
  automaticDeselectionDepth += 1
  try {
    return clear()
  } finally {
    automaticDeselectionDepth -= 1
  }
}

export function isAutomaticDeselection(): boolean {
  return automaticDeselectionDepth > 0
}

export type EnclosingWorktreeRemoval = { hostId: ExecutionHostId; repoId?: string }
type IntentListener = (scope: EnclosingWorktreeRemoval | null, entering: boolean) => void
const intentListeners = new Set<IntentListener>()

export function subscribeWorktreeDeselectionIntent(listener: IntentListener): () => void {
  intentListeners.add(listener)
  return () => {
    intentListeners.delete(listener)
  }
}

export function cancelActiveWorktreeRemoval(): void {
  if (!isAutomaticDeselection()) {
    intentListeners.forEach((listener) => listener(null, true))
  }
}

// Each caller owns a finite operation; unrelated hosts remain eligible during its awaits.
export function beginEnclosingWorktreeRemoval(scope: EnclosingWorktreeRemoval): () => void {
  intentListeners.forEach((listener) => listener(scope, true))
  return () => intentListeners.forEach((listener) => listener(scope, false))
}

export async function runEnclosingWorktreeRemoval<T>(
  scope: EnclosingWorktreeRemoval | null,
  remove: () => Promise<T>
): Promise<T> {
  const finish = scope ? beginEnclosingWorktreeRemoval(scope) : undefined
  try {
    return await remove()
  } finally {
    finish?.()
  }
}
