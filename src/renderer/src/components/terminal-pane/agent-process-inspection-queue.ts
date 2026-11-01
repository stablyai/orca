export type InspectionPriority = 'cadence' | 'pending-title'

type InspectionTask = {
  priority: InspectionPriority
  canRun: () => boolean
  run: () => Promise<void>
  /** Local panes share a TTL/in-flight-deduped host capture, so the round consumes one observation. */
  sharesHostObservation?: boolean
}

const MAX_CONCURRENT_INSPECTIONS = 4
const MAX_INSPECTION_STARTS_PER_SECOND = 8

let activeInspections = 0
let inspectionPumpQueued = false
let inspectionPumpTimer: ReturnType<typeof setTimeout> | null = null
const inspectionStarts: number[] = []
const inspectionQueue: InspectionTask[] = []

/** Budget host observations: one per shared round or unshared task. */
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

/** Batch synchronous enqueues in a microtask so a shared burst consumes one start rather than per-pane slots. */
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
    // Start shared reads in one tick for one capture; catch before finally to contain rejections while coordinators own failure/backoff.
    void task
      .run()
      .catch(() => {})
      .finally(settleOne)
  }
}

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
  // Charge one start for the full shared backlog so pane count cannot stretch completion latency.
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
