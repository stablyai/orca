type InputLaneTask = () => Promise<boolean> | boolean
type QueuedOperation =
  | { kind: 'input'; task: () => boolean; size: number }
  | {
      kind: 'quick'
      task: InputLaneTask
      resolve: (value: boolean) => void
    }

// Bound deferred keystrokes while the host performs the semantic-submit handshake.
export const TERMINAL_INPUT_ORDERING_LANE_MAX_PENDING = 2048
export const TERMINAL_INPUT_ORDERING_LANE_MAX_PENDING_CODE_UNITS = 256 * 1024

export function createTerminalInputOrderingLane() {
  const queue: QueuedOperation[] = []
  let running = false
  let pendingInputCodeUnits = 0

  async function run(): Promise<void> {
    if (running) {
      return
    }
    running = true
    try {
      while (queue.length > 0) {
        const operation = queue.shift()!
        if (operation.kind === 'input') {
          pendingInputCodeUnits -= operation.size
          try {
            operation.task()
          } catch {
            // A detached transport is allowed to reject queued input without stopping later operations.
          }
          continue
        }
        try {
          operation.resolve(await operation.task())
        } catch {
          operation.resolve(false)
        }
      }
    } finally {
      running = false
      if (queue.length > 0) {
        void run()
      }
    }
  }

  return {
    enqueueQuickCommand(task: InputLaneTask): Promise<boolean> {
      return new Promise<boolean>((resolve) => {
        if (queue.length >= TERMINAL_INPUT_ORDERING_LANE_MAX_PENDING) {
          resolve(false)
          return
        }
        queue.push({ kind: 'quick', task, resolve })
        void run()
      })
    },

    enqueueInput(task: () => boolean, size = 0): boolean {
      if (!running && queue.length === 0) {
        return task()
      }
      if (
        queue.length >= TERMINAL_INPUT_ORDERING_LANE_MAX_PENDING ||
        pendingInputCodeUnits + size > TERMINAL_INPUT_ORDERING_LANE_MAX_PENDING_CODE_UNITS
      ) {
        return false
      }
      queue.push({ kind: 'input', task, size })
      pendingInputCodeUnits += size
      return true
    },

    clear(): void {
      // Reject deferred commands on detach so their promises and payload accounting do not linger.
      for (const operation of queue) {
        if (operation.kind === 'quick') {
          operation.resolve(false)
        }
      }
      queue.length = 0
      pendingInputCodeUnits = 0
    }
  }
}
