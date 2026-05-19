export type InspectionPriority = 'cadence' | 'pending-title'

type InspectionTask = {
  priority: InspectionPriority
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
  const now = Date.now()
  if (!canStartInspection(now)) {
    scheduleInspectionPump(100)
    return
  }

  const priorityIndex = inspectionQueue.findIndex((task) => task.priority === 'pending-title')
  const next =
    priorityIndex >= 0 ? inspectionQueue.splice(priorityIndex, 1)[0] : inspectionQueue.shift()
  if (!next) {
    return
  }

  activeInspections += 1
  inspectionStarts.push(now)
  void next.run().finally(() => {
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
