export type CompletionIdentitySource = 'hook' | 'title' | 'process-exit'

export type LastCompletionIdentity = {
  source: CompletionIdentitySource
  identity: string
  agentIdentity: string | null
  lastTurnCompletedAtNotified?: number
}

type PendingStampedTail = {
  turnCompletedAt: number
  originLane: string
  eligibleWorkingBoundaryByLane: Map<string, number>
  consumedIdentityByLane: Map<string, string>
  tailOpen: boolean
}

const lastCompletionByPane = new Map<string, LastCompletionIdentity>()
const handledTurnCompletedAtsByPane = new Map<string, number[]>()
const pendingStampedTailByPane = new Map<string, PendingStampedTail>()
const workingBoundaryByPane = new Map<string, Map<string, number>>()
const coordinatorCountByPane = new Map<string, number>()
const HANDLED_TURN_STAMP_LIMIT = 16
let nextCoordinatorId = 1

export type AgentCompletionIdentityScope = {
  lane: string
  getLast: () => LastCompletionIdentity | undefined
  setLast: (identity: LastCompletionIdentity) => void
  deleteLast: () => void
  turnCompletedAtAlreadyHandled: (turnCompletedAt: number) => boolean
  rememberTurnCompletedAt: (turnCompletedAt: number) => void
  recordWorkingBoundary: (stateStartedAt: number | undefined) => void
  clearWorkingBoundary: () => void
  openStampedTail: (turnCompletedAt: number) => boolean
  consumePendingStampedTailForAgent: (
    agentIdentity: string | null,
    completionIdentity: string | null
  ) => boolean
  consumeStampedTail: (turnCompletedAt: number) => void
  hasUnconsumedStampedTail: () => boolean
  hasConsumedIdentity: (identity: string) => boolean
  clearOriginStampedTail: () => void
  clearStampedTail: () => void
  dispose: (isLive: boolean) => void
}

export function createAgentCompletionIdentityScope(
  paneKey: string,
  statusLane?: 'hook' | 'pty'
): AgentCompletionIdentityScope {
  const lane = statusLane ?? `coordinator:${nextCoordinatorId++}`
  let inheritedWorkingBoundary = pendingStampedTailByPane
    .get(paneKey)
    ?.eligibleWorkingBoundaryByLane.get(lane)
  coordinatorCountByPane.set(paneKey, (coordinatorCountByPane.get(paneKey) ?? 0) + 1)

  function recordWorkingBoundary(stateStartedAt: number | undefined): void {
    let boundaries = workingBoundaryByPane.get(paneKey)
    if (typeof stateStartedAt !== 'number' || !Number.isFinite(stateStartedAt)) {
      boundaries?.delete(lane)
      if (boundaries?.size === 0) {
        workingBoundaryByPane.delete(paneKey)
      }
      return
    }
    if (!boundaries) {
      boundaries = new Map()
      workingBoundaryByPane.set(paneKey, boundaries)
    }
    inheritedWorkingBoundary = undefined
    boundaries.set(lane, stateStartedAt)
  }

  function clearWorkingBoundary(): void {
    inheritedWorkingBoundary = undefined
    const boundaries = workingBoundaryByPane.get(paneKey)
    boundaries?.delete(lane)
    if (boundaries?.size === 0) {
      workingBoundaryByPane.delete(paneKey)
    }
  }

  function wasTurnCompletedAtHandled(turnCompletedAt: number): boolean {
    return (
      handledTurnCompletedAtsByPane.get(paneKey)?.includes(turnCompletedAt) === true ||
      lastCompletionByPane.get(paneKey)?.lastTurnCompletedAtNotified === turnCompletedAt
    )
  }

  function openStampedTail(turnCompletedAt: number): boolean {
    if (wasTurnCompletedAtHandled(turnCompletedAt)) {
      return true
    }
    const eligibleWorkingBoundaryByLane = new Map(workingBoundaryByPane.get(paneKey))
    eligibleWorkingBoundaryByLane.delete(lane)
    pendingStampedTailByPane.set(paneKey, {
      turnCompletedAt,
      originLane: lane,
      eligibleWorkingBoundaryByLane,
      consumedIdentityByLane: new Map(),
      tailOpen: true
    })
    return false
  }

  function consumePendingStampedTailForAgent(
    agentIdentity: string | null,
    completionIdentity: string | null
  ): boolean {
    const pending = pendingStampedTailByPane.get(paneKey)
    const stampedCompletion = lastCompletionByPane.get(paneKey)
    const currentWorkingBoundary = workingBoundaryByPane.get(paneKey)?.get(lane)
    const eligibleWorkingBoundary = pending?.eligibleWorkingBoundaryByLane.get(lane)
    if (
      !pending ||
      stampedCompletion?.lastTurnCompletedAtNotified !== pending.turnCompletedAt ||
      agentIdentity === null ||
      stampedCompletion.agentIdentity !== agentIdentity ||
      eligibleWorkingBoundary === undefined ||
      (currentWorkingBoundary !== eligibleWorkingBoundary &&
        inheritedWorkingBoundary !== eligibleWorkingBoundary)
    ) {
      return false
    }
    pending.eligibleWorkingBoundaryByLane.delete(lane)
    inheritedWorkingBoundary = undefined
    if (completionIdentity) {
      pending.consumedIdentityByLane.set(lane, completionIdentity)
    }
    pending.tailOpen = pending.eligibleWorkingBoundaryByLane.size > 0
    return true
  }

  return {
    lane,
    getLast: () => lastCompletionByPane.get(paneKey),
    setLast: (identity) => lastCompletionByPane.set(paneKey, identity),
    deleteLast: () => lastCompletionByPane.delete(paneKey),
    turnCompletedAtAlreadyHandled: (turnCompletedAt) =>
      handledTurnCompletedAtsByPane.get(paneKey)?.includes(turnCompletedAt) === true ||
      lastCompletionByPane.get(paneKey)?.lastTurnCompletedAtNotified === turnCompletedAt,
    rememberTurnCompletedAt: (turnCompletedAt) => {
      const handled = handledTurnCompletedAtsByPane.get(paneKey) ?? []
      if (handled.includes(turnCompletedAt)) {
        return
      }
      handled.push(turnCompletedAt)
      if (handled.length > HANDLED_TURN_STAMP_LIMIT) {
        handled.shift()
      }
      handledTurnCompletedAtsByPane.set(paneKey, handled)
    },
    recordWorkingBoundary,
    clearWorkingBoundary,
    openStampedTail,
    consumePendingStampedTailForAgent,
    consumeStampedTail: (turnCompletedAt) => {
      const pending = pendingStampedTailByPane.get(paneKey)
      if (pending?.turnCompletedAt !== turnCompletedAt) {
        return
      }
      pending.eligibleWorkingBoundaryByLane.delete(lane)
      pending.tailOpen = pending.eligibleWorkingBoundaryByLane.size > 0
    },
    hasUnconsumedStampedTail: () => pendingStampedTailByPane.get(paneKey)?.tailOpen === true,
    hasConsumedIdentity: (identity) =>
      pendingStampedTailByPane.get(paneKey)?.consumedIdentityByLane.get(lane) === identity,
    clearOriginStampedTail: () => {
      const pending = pendingStampedTailByPane.get(paneKey)
      if (pending?.originLane === lane) {
        pendingStampedTailByPane.delete(paneKey)
        if (
          lastCompletionByPane.get(paneKey)?.lastTurnCompletedAtNotified === pending.turnCompletedAt
        ) {
          lastCompletionByPane.delete(paneKey)
        }
      }
    },
    clearStampedTail: () => {
      pendingStampedTailByPane.delete(paneKey)
    },
    dispose: (isLive) => {
      const remaining = (coordinatorCountByPane.get(paneKey) ?? 1) - 1
      if (remaining > 0) {
        coordinatorCountByPane.set(paneKey, remaining)
      } else {
        coordinatorCountByPane.delete(paneKey)
      }
      if (remaining <= 0 && !isLive) {
        lastCompletionByPane.delete(paneKey)
        handledTurnCompletedAtsByPane.delete(paneKey)
        pendingStampedTailByPane.delete(paneKey)
        workingBoundaryByPane.delete(paneKey)
      }
    }
  }
}

export function resetAgentCompletionIdentityStoreForTest(): void {
  lastCompletionByPane.clear()
  handledTurnCompletedAtsByPane.clear()
  pendingStampedTailByPane.clear()
  workingBoundaryByPane.clear()
  coordinatorCountByPane.clear()
  nextCoordinatorId = 1
}

export function getAgentCompletionIdentityStoreSizeForTest(): number {
  return new Set([
    ...lastCompletionByPane.keys(),
    ...handledTurnCompletedAtsByPane.keys(),
    ...pendingStampedTailByPane.keys(),
    ...workingBoundaryByPane.keys()
  ]).size
}

export const resetAgentCompletionCoordinatorIdentitiesForTest =
  resetAgentCompletionIdentityStoreForTest
export const getAgentCompletionCoordinatorIdentityCountForTest =
  getAgentCompletionIdentityStoreSizeForTest
