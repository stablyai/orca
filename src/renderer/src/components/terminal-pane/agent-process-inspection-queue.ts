export type InspectionPriority = 'cadence' | 'pending-title'

type InspectionTask = {
  priority: InspectionPriority
  canRun: () => boolean
  run: () => Promise<void>
}

const MAX_CONCURRENT_INSPECTIONS = 4
const MAX_INSPECTION_STARTS_PER_SECOND = 8

let activeInspections = 0
let inspectionPumpTimer: ReturnType<typeof setTimeout> | null = null
const inspectionStarts: number[] = []
const inspectionQueue: InspectionTask[] = []

function canStartInspection(now: number): boolean {
  if (inspectionStarts.length > 0 && now < inspectionStarts[0]!) {
    inspectionStarts.length = 0
  }
  while (inspectionStarts.length > 0 && now - inspectionStarts[0]! >= 1_000) {
    inspectionStarts.shift()
  }
  return (
    activeInspections < MAX_CONCURRENT_INSPECTIONS &&
    inspectionStarts.length < MAX_INSPECTION_STARTS_PER_SECOND
  )
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

function pumpInspectionQueue(): void {
  // Drop disposed tasks before slot/rate accounting.
  for (let index = inspectionQueue.length - 1; index >= 0; index -= 1) {
    const task = inspectionQueue[index]
    if (task && !task.canRun()) {
      inspectionQueue.splice(index, 1)
    }
  }
  if (inspectionQueue.length === 0) {
    return
  }
  const now = Date.now()
  if (!canStartInspection(now)) {
    scheduleInspectionPump(100)
    return
  }

  const priorityIndex = inspectionQueue.findIndex((task) => task.priority === 'pending-title')
  const next =
    priorityIndex !== -1 ? inspectionQueue.splice(priorityIndex, 1)[0] : inspectionQueue.shift()
  if (!next) {
    return
  }

  activeInspections += 1
  inspectionStarts.push(now)
  // Why the catch before finally: an unreachable runtime rejects the inspection on a cadence, and a
  // bare `.finally()` chain re-raises it as a renderer-global unhandledrejection. Coordinators own
  // their own failure/backoff state, so the queue only has to keep its accounting running.
  void next
    .run()
    .catch(() => {})
    .finally(() => {
      activeInspections = Math.max(0, activeInspections - 1)
      if (inspectionQueue.length > 0) {
        scheduleInspectionPump()
      }
    })

  if (inspectionQueue.length > 0) {
    scheduleInspectionPump()
  }
}

export function enqueueAgentProcessInspection(task: InspectionTask): void {
  inspectionQueue.push(task)
  pumpInspectionQueue()
}

export function resetAgentProcessInspectionQueueForTests(): void {
  if (inspectionPumpTimer !== null) {
    clearTimeout(inspectionPumpTimer)
    inspectionPumpTimer = null
  }
  activeInspections = 0
  inspectionStarts.length = 0
  inspectionQueue.length = 0
}
