/**
 * The four-slot request pool every authority call goes through.
 *
 * Priority work (the selected host, and Desktop + Self) jumps the queue, and
 * queued work that the catalog has made obsolete is dropped before it is sent —
 * transport already in flight is left to finish and rejected by the commit fence
 * instead, because cancelling it would not un-send it.
 */

export const AUTOMATION_HOST_REQUEST_CONCURRENCY = 4

export type AutomationHostPoolJob = {
  priority?: boolean
  run: () => Promise<void>
  /** Runs instead of `run` when the job is dropped before it starts. */
  cancel?: () => void
}

export type AutomationHostRequestPool = {
  submit: (job: AutomationHostPoolJob) => Promise<void>
  cancelQueued: () => void
  inFlight: () => number
  queued: () => number
  /** Resolves once nothing is queued or in flight. */
  idle: () => Promise<void>
}

type WaitingJob = {
  job: AutomationHostPoolJob
  settle: () => void
}

export function createAutomationHostRequestPool(
  concurrency: number = AUTOMATION_HOST_REQUEST_CONCURRENCY
): AutomationHostRequestPool {
  const urgent: WaitingJob[] = []
  const waiting: WaitingJob[] = []
  const idleWaiters: (() => void)[] = []
  let active = 0

  const pending = (): number => urgent.length + waiting.length

  const releaseIdle = (): void => {
    if (active > 0 || pending() > 0) {
      return
    }
    for (const waiter of idleWaiters.splice(0)) {
      waiter()
    }
  }

  const pump = (): void => {
    while (active < concurrency && pending() > 0) {
      const next = urgent.shift() ?? waiting.shift()
      if (!next) {
        break
      }
      active += 1
      void next.job.run().then(
        () => {
          active -= 1
          next.settle()
          pump()
          releaseIdle()
        },
        () => {
          // Jobs own their error handling; the pool only tracks occupancy.
          active -= 1
          next.settle()
          pump()
          releaseIdle()
        }
      )
    }
    releaseIdle()
  }

  return {
    submit: (job) =>
      new Promise<void>((resolve) => {
        ;(job.priority === true ? urgent : waiting).push({ job, settle: resolve })
        pump()
      }),
    cancelQueued: () => {
      for (const entry of [...urgent.splice(0), ...waiting.splice(0)]) {
        // Settling alone resolves the submitter without ever running the job, so a
        // dropped job must first hand back whatever it reserved on submission.
        entry.job.cancel?.()
        entry.settle()
      }
      releaseIdle()
    },
    inFlight: () => active,
    queued: () => pending(),
    idle: () =>
      active === 0 && pending() === 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            idleWaiters.push(resolve)
          })
  }
}
