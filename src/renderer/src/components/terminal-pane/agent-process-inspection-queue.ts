export type InspectionPriority = 'cadence' | 'pending-title'

type InspectionTask = {
  priority: InspectionPriority
  canRun: () => boolean
  run: () => Promise<void>
  /**
   * Reads served by one shared host observation. Every local pane's inspection resolves out of
   * the same TTL-and-in-flight-deduped process-table snapshot, so a whole round of them costs
   * the host one capture however many panes ride it.
   */
  sharesHostObservation?: boolean
}

const MAX_CONCURRENT_INSPECTIONS = 4
const MAX_INSPECTION_STARTS_PER_SECOND = 8

let activeInspections = 0
let inspectionPumpQueued = false
let inspectionPumpTimer: ReturnType<typeof setTimeout> | null = null
const inspectionStarts: number[] = []
const inspectionQueue: InspectionTask[] = []

/**
 * Host observations still admissible right now. A start is one observation, not one pane: a
 * shared-observation round costs one however many panes ride it, an unshared task costs one each.
 */
function availableInspectionStarts(now: number): number {
  if (inspectionStarts.length > 0 && now < inspectionStarts[0]!) {
    inspectionStarts.length = 0
  }
  while (inspectionStarts.length > 0 && now - inspectionStarts[0]! >= 1_000) {
    inspectionStarts.shift()
  }
  return Math.min(
    MAX_CONCURRENT_INSPECTIONS - activeInspections,
    MAX_INSPECTION_STARTS_PER_SECOND - inspectionStarts.length
  )
}

/**
 * Pump on a microtask, so a synchronous burst of enqueues forms one round. Pumping inline
 * spent a start per pane until the concurrency slots filled and then parked the rest of the
 * burst on the 100ms retry.
 */
function queueInspectionPump(): void {
  if (inspectionPumpQueued) {
    return
  }
  inspectionPumpQueued = true
  queueMicrotask(() => {
    inspectionPumpQueued = false
    pumpInspectionQueue()
  })
}

function scheduleInspectionPump(delayMs = 0): void {
  if (inspectionPumpTimer !== null) {
    return
  }
  inspectionPumpTimer = setTimeout(() => {
    inspectionPumpTimer = null
    pumpInspectionQueue()
  }, delayMs)
}

/** Compact disposed tasks out in one pass; a splice per drop is quadratic at pane scale. */
function dropDisposedInspections(): void {
  let write = 0
  for (let read = 0; read < inspectionQueue.length; read += 1) {
    const task = inspectionQueue[read]!
    if (task.canRun()) {
      inspectionQueue[write] = task
      write += 1
    }
  }
  inspectionQueue.length = write
}

function startInspectionRound(tasks: InspectionTask[], now: number): void {
  activeInspections += 1
  inspectionStarts.push(now)
  let outstanding = tasks.length
  const settleOne = (): void => {
    outstanding -= 1
    if (outstanding > 0) {
      return
    }
    activeInspections = Math.max(0, activeInspections - 1)
    if (inspectionQueue.length > 0) {
      scheduleInspectionPump()
    }
  }
  for (const task of tasks) {
    // Started synchronously so every read in the round lands in the same tick, hitting one
    // process-table capture instead of serializing one capture window apart.
    // Why the catch before finally: an unreachable runtime rejects the inspection on a cadence, and a
    // bare `.finally()` chain re-raises it as a renderer-global unhandledrejection. Coordinators own
    // their own failure/backoff state, so the queue only has to keep its accounting running.
    void task
      .run()
      .catch(() => {})
      .finally(settleOne)
  }
}

/** Take every shared-observation task, in order, leaving the rest queued. */
function takeSharedObservationRound(): InspectionTask[] {
  const round: InspectionTask[] = []
  let write = 0
  for (let read = 0; read < inspectionQueue.length; read += 1) {
    const task = inspectionQueue[read]!
    if (task.sharesHostObservation === true) {
      round.push(task)
    } else {
      inspectionQueue[write] = task
      write += 1
    }
  }
  inspectionQueue.length = write
  return round
}

function pumpInspectionQueue(): void {
  // Drop disposed tasks before slot/rate accounting.
  dropDisposedInspections()
  if (inspectionQueue.length === 0) {
    return
  }
  const now = Date.now()
  let starts = availableInspectionStarts(now)
  if (starts <= 0) {
    scheduleInspectionPump(100)
    return
  }
  // The whole shared-observation backlog goes on one start, so a pane's wait is bounded by the
  // observation budget rather than by how many other panes are also due.
  const sharedRound = takeSharedObservationRound()
  if (sharedRound.length > 0) {
    startInspectionRound(sharedRound, now)
    starts -= 1
  }
  while (starts > 0 && inspectionQueue.length > 0) {
    const priorityIndex = inspectionQueue.findIndex((task) => task.priority === 'pending-title')
    const next =
      priorityIndex !== -1 ? inspectionQueue.splice(priorityIndex, 1)[0] : inspectionQueue.shift()
    if (!next) {
      break
    }
    startInspectionRound([next], now)
    starts -= 1
  }

  if (inspectionQueue.length > 0) {
    scheduleInspectionPump()
  }
}

export function enqueueAgentProcessInspection(task: InspectionTask): void {
  inspectionQueue.push(task)
  queueInspectionPump()
}

export function resetAgentProcessInspectionQueueForTests(): void {
  if (inspectionPumpTimer !== null) {
    clearTimeout(inspectionPumpTimer)
    inspectionPumpTimer = null
  }
  inspectionPumpQueued = false
  activeInspections = 0
  inspectionStarts.length = 0
  inspectionQueue.length = 0
}
