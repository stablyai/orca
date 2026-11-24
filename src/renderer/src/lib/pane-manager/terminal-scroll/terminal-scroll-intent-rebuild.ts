import type { TerminalScrollIntentTarget } from './terminal-scroll-intent'

// Async rebuild exposes transient half-cleared viewportY/baseY; bracket it to prevent capturing line-zero intent, then restore once parsing finishes.
const terminalScrollIntentRebuilds = new WeakMap<TerminalScrollIntentTarget, number>()
const terminalScrollIntentRebuildCompletions = new WeakMap<
  TerminalScrollIntentTarget,
  Set<(completed: boolean) => void>
>()
const deferredTerminalGeometryMutations = new WeakMap<
  TerminalScrollIntentTarget,
  {
    mutations: Map<string, () => void>
  }
>()

function notifyRebuildCompletions(
  completions: Set<(completed: boolean) => void> | undefined,
  completed: boolean
): void {
  for (const completion of completions ?? []) {
    try {
      completion(completed)
    } catch (error) {
      // Optional observer failures must not strand rebuild or authoritative viewport restoration.
      console.error('[terminal] scroll-intent rebuild completion failed', error)
    }
  }
}

export function beginTerminalScrollIntentBufferRebuild(terminal: TerminalScrollIntentTarget): void {
  terminalScrollIntentRebuilds.set(terminal, (terminalScrollIntentRebuilds.get(terminal) ?? 0) + 1)
}

export function endTerminalScrollIntentBufferRebuild(terminal: TerminalScrollIntentTarget): void {
  const count = terminalScrollIntentRebuilds.get(terminal) ?? 0
  if (count <= 1) {
    terminalScrollIntentRebuilds.delete(terminal)
    const completions = terminalScrollIntentRebuildCompletions.get(terminal)
    terminalScrollIntentRebuildCompletions.delete(terminal)
    notifyRebuildCompletions(completions, true)
    return
  }
  terminalScrollIntentRebuilds.set(terminal, count - 1)
}

export function isTerminalScrollIntentRebuildInFlight(
  terminal: TerminalScrollIntentTarget
): boolean {
  return (terminalScrollIntentRebuilds.get(terminal) ?? 0) > 0
}

export function onTerminalScrollIntentBufferRebuildComplete(
  terminal: TerminalScrollIntentTarget,
  completion: (completed: boolean) => void
): () => void {
  if (!isTerminalScrollIntentRebuildInFlight(terminal)) {
    completion(true)
    return () => {}
  }
  let completions = terminalScrollIntentRebuildCompletions.get(terminal)
  if (!completions) {
    completions = new Set()
    terminalScrollIntentRebuildCompletions.set(terminal, completions)
  }
  completions.add(completion)
  return () => {
    completions?.delete(completion)
    if (completions?.size === 0) {
      terminalScrollIntentRebuildCompletions.delete(terminal)
    }
  }
}

// Finish source-grid replay/viewport restoration before unrelated fits can reflow the buffer.
export function deferTerminalGeometryMutationDuringRebuild(
  terminal: TerminalScrollIntentTarget,
  operationKey: string,
  mutation: () => void
): boolean {
  if (!isTerminalScrollIntentRebuildInFlight(terminal)) {
    return false
  }
  const existing = deferredTerminalGeometryMutations.get(terminal)
  if (existing) {
    existing.mutations.set(operationKey, mutation)
    return true
  }
  const mutations = new Map([[operationKey, mutation]])
  const deferred = { mutations }
  deferredTerminalGeometryMutations.set(terminal, deferred)
  onTerminalScrollIntentBufferRebuildComplete(terminal, (completed) => {
    if (deferredTerminalGeometryMutations.get(terminal) !== deferred) {
      return
    }
    if (!completed) {
      deferredTerminalGeometryMutations.delete(terminal)
      return
    }
    // Completion listeners precede viewport restore; defer geometry to a microtask after it.
    queueMicrotask(() => {
      if (deferredTerminalGeometryMutations.get(terminal) !== deferred) {
        return
      }
      // Keep cancellation live until execution; disposal can follow rebuild completion but precede the microtask.
      deferredTerminalGeometryMutations.delete(terminal)
      for (const [key, pendingMutation] of mutations) {
        if (!deferTerminalGeometryMutationDuringRebuild(terminal, key, pendingMutation)) {
          pendingMutation()
        }
      }
    })
  })
  return true
}

export function cancelTerminalScrollIntentBufferRebuildCompletions(
  terminal: TerminalScrollIntentTarget
): void {
  const completions = terminalScrollIntentRebuildCompletions.get(terminal)
  terminalScrollIntentRebuildCompletions.delete(terminal)
  notifyRebuildCompletions(completions, false)
  deferredTerminalGeometryMutations.delete(terminal)
}
