export type RestartUnsavedChangesDecision = 'cancel' | 'restart-anyway'

type PendingRequest = {
  filePaths: readonly string[]
  settle: (decision: RestartUnsavedChangesDecision) => void
}

let pending: PendingRequest | null = null
let previousDecision: Promise<unknown> = Promise.resolve()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function openRequest(filePaths: readonly string[]): Promise<RestartUnsavedChangesDecision> {
  if (listeners.size === 0) {
    return Promise.resolve('cancel')
  }
  return new Promise((resolve) => {
    pending = { filePaths, settle: resolve }
    notify()
  })
}

/** Asks the user whether to restart without the listed unsaved files; null when no dialog host is mounted. */
export function requestRestartUnsavedChangesDecision(
  filePaths: readonly string[]
): Promise<RestartUnsavedChangesDecision> | null {
  if (listeners.size === 0) {
    return null
  }
  // Why: the updater install and app restart paths don't share one in-flight guard, so their dialogs take turns.
  const decision = previousDecision.then(() => openRequest(filePaths))
  previousDecision = decision
  return decision
}

export function answerRestartUnsavedChangesRequest(decision: RestartUnsavedChangesDecision): void {
  const request = pending
  if (!request) {
    return
  }
  pending = null
  request.settle(decision)
  notify()
}

export function getRestartUnsavedChangesFilePaths(): readonly string[] | null {
  return pending?.filePaths ?? null
}

export function subscribeRestartUnsavedChangesRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
    // Why: an unmounted host can't answer, and the restart must not wait forever.
    if (listeners.size === 0) {
      answerRestartUnsavedChangesRequest('cancel')
    }
  }
}
