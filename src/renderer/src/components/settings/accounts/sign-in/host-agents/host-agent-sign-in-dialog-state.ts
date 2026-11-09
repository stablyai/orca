export type HostAgentSignInDialogTarget = { environmentId: string; hostLabel: string }

let target: HostAgentSignInDialogTarget | null = null
const listeners = new Set<() => void>()

function publish(next: HostAgentSignInDialogTarget | null): void {
  target = next
  for (const listener of listeners) {
    listener()
  }
}

export function openHostAgentSignInDialog(next: HostAgentSignInDialogTarget): void {
  publish(next)
}

export function closeHostAgentSignInDialog(): void {
  publish(null)
}

export function readHostAgentSignInDialogTarget(): HostAgentSignInDialogTarget | null {
  return target
}

export function subscribeHostAgentSignInDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
