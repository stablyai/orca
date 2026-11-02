/** Pool four authority calls; selected/Desktop Self jobs take priority. Drop obsolete queued work before send; already-sent work finishes behind the commit fence. */

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
        // Cancelled jobs must release their reservations before settling; they never reach run.
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
