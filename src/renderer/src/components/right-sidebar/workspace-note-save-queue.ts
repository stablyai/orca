type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'

export type WorkspaceNoteSaveAttempt = {
  queueKey: string
  comment: string
  requestId: number
}

export type WorkspaceNoteSaveQueue = {
  generation: number
  promise: Promise<void>
  inFlight: boolean
  pendingSave: WorkspaceNoteSaveAttempt | null
  failedSave: WorkspaceNoteSaveAttempt | null
}

export type WorkspaceNoteSaveQueueNotification = {
  status: Exclude<SaveStatus, 'idle'>
  attempt: WorkspaceNoteSaveAttempt
  pendingSave: WorkspaceNoteSaveAttempt | null
  failedSave: WorkspaceNoteSaveAttempt | null
}

type WorkspaceNoteSaveQueueSubscriber = (notification: WorkspaceNoteSaveQueueNotification) => void

type WorkspaceNoteSaveResult = { ok: boolean }
type WorkspaceNoteSaveOperation = (generation: number) => Promise<WorkspaceNoteSaveResult>

const workspaceNoteSaveQueuesByTarget = new Map<string, WorkspaceNoteSaveQueue>()
const workspaceNoteSaveSubscribersByTarget = new Map<
  string,
  Set<WorkspaceNoteSaveQueueSubscriber>
>()

export function getWorkspaceNoteSaveQueue(queueKey: string): WorkspaceNoteSaveQueue | undefined {
  return workspaceNoteSaveQueuesByTarget.get(queueKey)
}

export function getOrCreateWorkspaceNoteSaveQueue(queueKey: string): WorkspaceNoteSaveQueue {
  const existing = workspaceNoteSaveQueuesByTarget.get(queueKey)
  if (existing) {
    return existing
  }
  const created: WorkspaceNoteSaveQueue = {
    generation: 0,
    promise: Promise.resolve(),
    inFlight: false,
    pendingSave: null,
    failedSave: null
  }
  workspaceNoteSaveQueuesByTarget.set(queueKey, created)
  return created
}

export function setWorkspaceNoteSaveQueue(queueKey: string, queue: WorkspaceNoteSaveQueue): void {
  workspaceNoteSaveQueuesByTarget.set(queueKey, queue)
}

export function releaseSettledWorkspaceNoteSaveQueue(
  queueKey: string,
  queue: WorkspaceNoteSaveQueue,
  promise: Promise<void>
): void {
  if (
    workspaceNoteSaveQueuesByTarget.get(queueKey) === queue &&
    queue.promise === promise &&
    queue.pendingSave === null &&
    queue.failedSave === null
  ) {
    workspaceNoteSaveQueuesByTarget.delete(queueKey)
  }
}

export function subscribeToWorkspaceNoteSaveQueue(
  queueKey: string,
  subscriber: WorkspaceNoteSaveQueueSubscriber
): () => void {
  const subscribers = workspaceNoteSaveSubscribersByTarget.get(queueKey) ?? new Set()
  subscribers.add(subscriber)
  workspaceNoteSaveSubscribersByTarget.set(queueKey, subscribers)
  return () => {
    subscribers.delete(subscriber)
    if (subscribers.size === 0) {
      workspaceNoteSaveSubscribersByTarget.delete(queueKey)
    }
  }
}

export function notifyWorkspaceNoteSaveQueue(
  queueKey: string,
  status: Exclude<SaveStatus, 'idle'>,
  attempt: WorkspaceNoteSaveAttempt
): void {
  const subscribers = workspaceNoteSaveSubscribersByTarget.get(queueKey)
  if (!subscribers) {
    return
  }
  const queueState = workspaceNoteSaveQueuesByTarget.get(queueKey)
  const notification = {
    status,
    attempt,
    pendingSave: queueState?.pendingSave ?? null,
    failedSave: queueState?.failedSave ?? null
  } satisfies WorkspaceNoteSaveQueueNotification
  for (const subscriber of subscribers) {
    subscriber(notification)
  }
}

export function enqueueWorkspaceNoteSave(
  queueKey: string,
  attempt: WorkspaceNoteSaveAttempt,
  save: WorkspaceNoteSaveOperation,
  canStart: () => boolean
): Promise<void> {
  const queueState = getOrCreateWorkspaceNoteSaveQueue(queueKey)
  const generation = ++queueState.generation
  queueState.inFlight = true
  queueState.pendingSave = attempt
  queueState.failedSave = null

  const previous = queueState.promise
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      if (!canStart()) {
        queueState.inFlight = false
        return
      }

      notifyWorkspaceNoteSaveQueue(queueKey, 'saving', attempt)
      let completionStatus: Exclude<SaveStatus, 'idle'> | null = null
      try {
        const result = await save(generation)
        if (queueState.generation === generation) {
          if (result.ok) {
            queueState.failedSave = null
            completionStatus = 'saved'
          } else {
            queueState.failedSave = attempt
            completionStatus = 'error'
          }
        }
      } catch {
        if (queueState.generation === generation) {
          queueState.failedSave = attempt
          completionStatus = 'error'
        }
      } finally {
        if (queueState.pendingSave === attempt) {
          queueState.pendingSave = null
          queueState.inFlight = false
        }
        if (completionStatus) {
          notifyWorkspaceNoteSaveQueue(queueKey, completionStatus, attempt)
        }
      }
    })
  queueState.promise = next
  setWorkspaceNoteSaveQueue(queueKey, queueState)
  void next.then(
    () => releaseSettledWorkspaceNoteSaveQueue(queueKey, queueState, next),
    () => releaseSettledWorkspaceNoteSaveQueue(queueKey, queueState, next)
  )
  return next
}

export function resetWorkspaceNoteSaveStateForTests(): void {
  workspaceNoteSaveQueuesByTarget.clear()
  workspaceNoteSaveSubscribersByTarget.clear()
}
