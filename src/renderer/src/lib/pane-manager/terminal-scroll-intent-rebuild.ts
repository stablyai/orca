// Why: buffer rebuilds (snapshot replay clear + rewrite) parse asynchronously.
// Until the rebuild's bytes have parsed, viewportY/baseY describe a transient
// half-cleared buffer; any intent capture/enforce latched from it pins the
// terminal at line 0. Callers bracket the rebuild and re-apply intent once
// after parse (see terminal-scroll-intent.ts).
const terminalScrollIntentRebuilds = new WeakMap<object, number>()
const terminalScrollIntentRebuildCompletions = new WeakMap<
  object,
  Set<(completed: boolean) => void>
>()
const deferredTerminalGeometryMutations = new WeakMap<
  object,
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
      // Why: one optional observer must not strand the rebuild or prevent the
      // coordinator from restoring the authoritative viewport.
      console.error('[terminal] scroll-intent rebuild completion failed', error)
    }
  }
}

export function beginTerminalScrollIntentBufferRebuild(terminal: object): void {
  terminalScrollIntentRebuilds.set(terminal, (terminalScrollIntentRebuilds.get(terminal) ?? 0) + 1)
}

export function endTerminalScrollIntentBufferRebuild(terminal: object): void {
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

export function isTerminalScrollIntentRebuildInFlight(terminal: object): boolean {
  return (terminalScrollIntentRebuilds.get(terminal) ?? 0) > 0
}

export function onTerminalScrollIntentBufferRebuildComplete(
  terminal: object,
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

// Why: source-dimension replay must finish and restore its viewport before
// unrelated fit/resize work is allowed to reflow the rebuilt buffer.
export function deferTerminalGeometryMutationDuringRebuild(
  terminal: object,
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
    // Why: rebuild completion listeners run before the coordinator restores
    // intent; the microtask makes every geometry mutation post-restore.
    queueMicrotask(() => {
      if (deferredTerminalGeometryMutations.get(terminal) !== deferred) {
        return
      }
      // Keep the entry cancellable until execution begins; disposal may land
      // after rebuild completion but before this post-restore microtask.
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

export function cancelTerminalScrollIntentBufferRebuildCompletions(terminal: object): void {
  const completions = terminalScrollIntentRebuildCompletions.get(terminal)
  terminalScrollIntentRebuildCompletions.delete(terminal)
  notifyRebuildCompletions(completions, false)
  deferredTerminalGeometryMutations.delete(terminal)
}
