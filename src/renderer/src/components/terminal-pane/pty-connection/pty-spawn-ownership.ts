export type PtySpawnOwnershipAttempt = {
  paneKey: string
  token: symbol
  sequence: number
}

// A sibling that never reaches a terminal state must not retain a late PTY
// forever. This matches the transport's existing reconnect grace window: a
// normal IPC task has settled long before it, while a wedged connect gets a
// bounded cleanup decision.
export const PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS = 60_000
// Keep a late, never-settling connect from pinning the pane registry forever. This is
// deliberately longer than the ownership decision so a sibling can still publish its
// handoff claim before the abandoned attempt is forgotten.
export const PTY_SPAWN_OWNERSHIP_RECORD_RETENTION_TIMEOUT_MS =
  PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS * 3

type AttemptRecord = {
  attempt: PtySpawnOwnershipAttempt
  result?: { id: string; isReattach?: boolean; incarnationId?: string; accepted: boolean }
  done: boolean
  retentionTimer: ReturnType<typeof setTimeout>
}

type AcceptedClaim = {
  attempt: PtySpawnOwnershipAttempt
  id: string
  isReattach: true
  incarnationId?: string
}

const attemptsByPaneKey = new Map<string, Set<AttemptRecord>>()
const acceptedClaimsByPaneKey = new Map<string, Set<AcceptedClaim>>()
const paneChangeWaitersByKey = new Map<string, Set<() => void>>()
let nextAttemptSequence = 0

function signalPaneChange(paneKey: string): void {
  const waiters = paneChangeWaitersByKey.get(paneKey)
  if (!waiters) {
    return
  }
  paneChangeWaitersByKey.delete(paneKey)
  for (const resolve of waiters) {
    resolve()
  }
}

function waitForPaneChange(paneKey: string): { promise: Promise<void>; cancel: () => void } {
  let resolveChange!: () => void
  const promise = new Promise<void>((resolve) => {
    resolveChange = resolve
  })
  let waiters = paneChangeWaitersByKey.get(paneKey)
  if (!waiters) {
    waiters = new Set()
    paneChangeWaitersByKey.set(paneKey, waiters)
  }
  waiters.add(resolveChange)
  return {
    promise,
    cancel: () => {
      waiters?.delete(resolveChange)
      if (waiters?.size === 0 && paneChangeWaitersByKey.get(paneKey) === waiters) {
        paneChangeWaitersByKey.delete(paneKey)
      }
    }
  }
}

export function beginPtySpawnOwnership(paneKey: string | null): PtySpawnOwnershipAttempt | null {
  if (!paneKey) {
    return null
  }
  const attempt = { paneKey, token: Symbol('pty-spawn'), sequence: ++nextAttemptSequence }
  const record: AttemptRecord = {
    attempt,
    done: false,
    retentionTimer: setTimeout(() => {
      if (!record.result && !record.done) {
        removeAttemptRecord(record)
      }
    }, PTY_SPAWN_OWNERSHIP_RECORD_RETENTION_TIMEOUT_MS)
  }
  let attempts = attemptsByPaneKey.get(paneKey)
  if (!attempts) {
    attempts = new Set()
    attemptsByPaneKey.set(paneKey, attempts)
  }
  attempts.add(record)
  signalPaneChange(paneKey)
  return attempt
}

function findAttempt(attempt: PtySpawnOwnershipAttempt): AttemptRecord | undefined {
  return [...(attemptsByPaneKey.get(attempt.paneKey) ?? [])].find(
    (record) => record.attempt.token === attempt.token
  )
}

function removeAttemptRecord(record: AttemptRecord): void {
  clearTimeout(record.retentionTimer)
  const attempts = attemptsByPaneKey.get(record.attempt.paneKey)
  if (!attempts) {
    return
  }
  attempts.delete(record)
  if (attempts.size === 0) {
    attemptsByPaneKey.delete(record.attempt.paneKey)
  }
  signalPaneChange(record.attempt.paneKey)
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
  if (record.result.accepted && result.isReattach) {
    let claims = acceptedClaimsByPaneKey.get(attempt.paneKey)
    if (!claims) {
      claims = new Set()
      acceptedClaimsByPaneKey.set(attempt.paneKey, claims)
    }
    claims.add({
      attempt,
      id: result.id,
      isReattach: true,
      ...(result.incarnationId ? { incarnationId: result.incarnationId } : {})
    })
  } else if (record.result.accepted) {
    // A newly admitted fresh PTY supersedes retained reattach claims for this pane.
    acceptedClaimsByPaneKey.delete(attempt.paneKey)
  }
  signalPaneChange(attempt.paneKey)
}

export function hasPtySpawnOwnershipClaim(attempt: PtySpawnOwnershipAttempt | null): boolean {
  if (!attempt) {
    return false
  }
  return [...(acceptedClaimsByPaneKey.get(attempt.paneKey) ?? [])].some(
    (claim) => claim.attempt.token === attempt.token
  )
}

/** Releases a claim held by a transport whose PTY was explicitly disconnected. */
export function releasePtySpawnOwnership(attempt: PtySpawnOwnershipAttempt | null): void {
  if (!attempt) {
    return
  }
  const claims = acceptedClaimsByPaneKey.get(attempt.paneKey)
  if (claims) {
    for (const claim of claims) {
      if (claim.attempt.token === attempt.token) {
        claims.delete(claim)
      }
    }
    if (claims.size === 0) {
      acceptedClaimsByPaneKey.delete(attempt.paneKey)
    }
  }
  const record = findAttempt(attempt)
  if (
    record &&
    (record.result?.accepted === true || (record.result === undefined && record.done))
  ) {
    removeAttemptRecord(record)
  }
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
  clearTimeout(record.retentionTimer)
  signalPaneChange(attempt.paneKey)
  // Keep completed siblings until the predecessor consumes their result. A
  // delayed IPC reply can arrive after the replacement has already finished
  // binding, so removing it at the replacement's `finally` reintroduces the
  // same timing race this registry exists to close.
  if ([...attempts].every((candidate) => candidate.done)) {
    for (const candidate of attempts) {
      clearTimeout(candidate.retentionTimer)
    }
    acceptedClaimsByPaneKey.delete(attempt.paneKey)
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
  const sameResult = (candidate: AttemptRecord | undefined): boolean => {
    const candidateResult = candidate?.result
    return Boolean(
      candidate &&
      candidate.attempt.sequence > attempt.sequence &&
      candidateResult?.isReattach &&
      candidateResult.accepted &&
      candidateResult.id === result.id &&
      (!result.incarnationId || candidateResult.incarnationId === result.incarnationId)
    )
  }
  const claimMatches = (): boolean =>
    [...(acceptedClaimsByPaneKey.get(attempt.paneKey) ?? [])].some(
      (claim) =>
        claim.attempt.sequence > attempt.sequence &&
        claim.isReattach &&
        claim.id === result.id &&
        (!result.incarnationId || claim.incarnationId === result.incarnationId)
    )
  if (claimMatches()) {
    return true
  }
  if (!findAttempt(attempt)) {
    return false
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let finalTimeoutId: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  let finallyTimedOut = false
  const timeout = new Promise<void>((resolve) => {
    timeoutId = setTimeout(() => {
      timedOut = true
      resolve()
    }, PTY_SPAWN_OWNERSHIP_SETTLE_TIMEOUT_MS)
  })
  const finalTimeout = new Promise<void>((resolve) => {
    finalTimeoutId = setTimeout(() => {
      finallyTimedOut = true
      resolve()
    }, PTY_SPAWN_OWNERSHIP_RECORD_RETENTION_TIMEOUT_MS)
  })
  while (true) {
    const attempts = attemptsByPaneKey.get(attempt.paneKey)
    const own = findAttempt(attempt)
    if (!attempts || !own) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      if (finalTimeoutId !== undefined) {
        clearTimeout(finalTimeoutId)
      }
      return false
    }
    const siblings = [...attempts].filter((candidate) => candidate !== own)
    if (claimMatches() || siblings.some(sameResult)) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      if (finalTimeoutId !== undefined) {
        clearTimeout(finalTimeoutId)
      }
      return true
    }
    if (!siblings.some((candidate) => !candidate.result && !candidate.done)) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      if (finalTimeoutId !== undefined) {
        clearTimeout(finalTimeoutId)
      }
      return false
    }
    const change = waitForPaneChange(attempt.paneKey)
    await Promise.race([change.promise, timedOut ? finalTimeout : timeout])
    change.cancel()
    if (finallyTimedOut) {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
      }
      if (finalTimeoutId !== undefined) {
        clearTimeout(finalTimeoutId)
      }
      return claimMatches()
    }
  }
}

export function resetPtySpawnOwnershipForTests(): void {
  for (const attempts of attemptsByPaneKey.values()) {
    for (const record of attempts) {
      clearTimeout(record.retentionTimer)
    }
  }
  for (const waiters of paneChangeWaitersByKey.values()) {
    for (const resolve of waiters) {
      resolve()
    }
  }
  attemptsByPaneKey.clear()
  acceptedClaimsByPaneKey.clear()
  paneChangeWaitersByKey.clear()
  nextAttemptSequence = 0
}
