export type PtySpawnOwnershipAttempt = {
  paneKey: string
  token: symbol
}

// A sibling that never reaches a terminal state must not retain a late PTY
// forever. This matches the transport's existing reconnect grace window: a
// normal IPC task has settled long before it, while a wedged connect gets a
// bounded cleanup decision.
export const PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS = 60_000

type AttemptRecord = {
  attempt: PtySpawnOwnershipAttempt
  result?: { id: string; isReattach?: boolean; incarnationId?: string; accepted: boolean }
  done: boolean
  resolveResult: () => void
  resultPromise: Promise<void>
}

const attemptsByPaneKey = new Map<string, Set<AttemptRecord>>()

export function beginPtySpawnOwnership(paneKey: string | null): PtySpawnOwnershipAttempt | null {
  if (!paneKey) {
    return null
  }
  const attempt = { paneKey, token: Symbol('pty-spawn') }
  let resolveResult!: () => void
  const resultPromise = new Promise<void>((resolve) => {
    resolveResult = resolve
  })
  const record: AttemptRecord = {
    attempt,
    done: false,
    resolveResult,
    resultPromise
  }
  let attempts = attemptsByPaneKey.get(paneKey)
  if (!attempts) {
    attempts = new Set()
    attemptsByPaneKey.set(paneKey, attempts)
  }
  attempts.add(record)
  return attempt
}

function findAttempt(attempt: PtySpawnOwnershipAttempt): AttemptRecord | undefined {
  return [...(attemptsByPaneKey.get(attempt.paneKey) ?? [])].find(
    (record) => record.attempt.token === attempt.token
  )
}

export function publishPtySpawnOwnership(
  attempt: PtySpawnOwnershipAttempt | null,
  result: { id: string; isReattach?: boolean; incarnationId?: string },
  options: { accepted?: boolean } = {}
): void {
  if (!attempt) {
    return
  }
  const record = findAttempt(attempt)
  if (!record || record.result) {
    return
  }
  record.result = { ...result, accepted: options.accepted !== false }
  record.resolveResult()
}

export function finishPtySpawnOwnership(attempt: PtySpawnOwnershipAttempt | null): void {
  if (!attempt) {
    return
  }
  const attempts = attemptsByPaneKey.get(attempt.paneKey)
  const record = findAttempt(attempt)
  if (!attempts || !record) {
    return
  }
  record.done = true
  record.resolveResult()
  // Keep completed siblings until the predecessor consumes their result. A
  // delayed IPC reply can arrive after the replacement has already finished
  // binding, so removing it at the replacement's `finally` reintroduces the
  // same timing race this registry exists to close.
  if ([...attempts].every((candidate) => candidate.done)) {
    attempts.clear()
    attemptsByPaneKey.delete(attempt.paneKey)
  }
}

/**
 * Waits for a concurrent connect to prove it adopted this exact result. A
 * fresh/different result makes the late PTY unowned and therefore killable.
 */
export async function successorOwnsPtySpawnResult(
  attempt: PtySpawnOwnershipAttempt | null,
  result: { id: string; incarnationId?: string }
): Promise<boolean> {
  if (!attempt) {
    return false
  }
  const attempts = attemptsByPaneKey.get(attempt.paneKey)
  const own = findAttempt(attempt)
  if (!attempts || !own) {
    return false
  }
  const siblings = [...attempts].filter((candidate) => candidate !== own)
  if (siblings.length === 0) {
    return false
  }
  const sameResult = (candidate: AttemptRecord): boolean => {
    const candidateResult = candidate.result
    return Boolean(
      candidateResult?.isReattach &&
      candidateResult.accepted &&
      candidateResult.id === result.id &&
      (!result.incarnationId || candidateResult.incarnationId === result.incarnationId)
    )
  }
  const hasClaim = (): boolean => siblings.some(sameResult)
  if (hasClaim()) {
    return true
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      resolve()
    }, PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS)
  })
  while (siblings.some((candidate) => !candidate.result && !candidate.done)) {
    await Promise.race([
      timeout,
      ...siblings
        .filter((candidate) => !candidate.result && !candidate.done)
        .map((candidate) => candidate.resultPromise)
    ])
    if (hasClaim()) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      return true
    }
    if (timedOut) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      return false
    }
  }
  if (timeoutId !== undefined) {
    clearTimeout(timeoutId)
  }
  return hasClaim()
}

export function resetPtySpawnOwnershipForTests(): void {
  attemptsByPaneKey.clear()
}
