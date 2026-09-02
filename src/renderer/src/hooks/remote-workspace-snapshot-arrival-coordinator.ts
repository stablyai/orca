type SnapshotArrivalOperation = (arrival: number, signal: AbortSignal) => Promise<void>

type SnapshotArrivalTargetState = {
  arrival: number
  activeOperations: number
  controller: AbortController | null
}

export type RemoteWorkspaceSnapshotArrivalCoordinator = {
  isCurrent: (targetId: string, arrival: number) => boolean
  run: (targetId: string, operation: SnapshotArrivalOperation) => Promise<void>
  stop: () => void
}

export function createRemoteWorkspaceSnapshotArrivalCoordinator(): RemoteWorkspaceSnapshotArrivalCoordinator {
  const stateByTarget = new Map<string, SnapshotArrivalTargetState>()
  let stopped = false

  const isCurrent = (targetId: string, arrival: number): boolean =>
    !stopped && stateByTarget.get(targetId)?.arrival === arrival

  const run = async (targetId: string, operation: SnapshotArrivalOperation): Promise<void> => {
    if (stopped) {
      return
    }
    const state = stateByTarget.get(targetId) ?? {
      arrival: 0,
      activeOperations: 0,
      controller: null
    }
    state.arrival += 1
    state.activeOperations += 1
    state.controller?.abort()
    const controller = new AbortController()
    state.controller = controller
    stateByTarget.set(targetId, state)
    const arrival = state.arrival
    try {
      await operation(arrival, controller.signal)
    } finally {
      state.activeOperations -= 1
      if (state.controller === controller) {
        state.controller = null
      }
      if (state.activeOperations === 0 && stateByTarget.get(targetId) === state) {
        stateByTarget.delete(targetId)
      }
    }
  }

  const stop = (): void => {
    stopped = true
    for (const state of stateByTarget.values()) {
      state.controller?.abort()
    }
    stateByTarget.clear()
  }

  return { isCurrent, run, stop }
}
