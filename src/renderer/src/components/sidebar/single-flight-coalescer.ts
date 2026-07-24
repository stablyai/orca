// Single-flight: runs `task` on the first request; requests during a run collapse into one
// trailing re-run. Stops staggered wake reconnects firing K sidebar refreshes at once (#8539).
export type SingleFlightCoalescer = {
  request: () => void
}

export function createSingleFlightCoalescer(task: () => Promise<unknown>): SingleFlightCoalescer {
  let inFlight = false
  let pending = false

  const run = (): void => {
    inFlight = true
    // Microtask-defer so a sync throw in `task` can't wedge inFlight.
    Promise.resolve()
      .then(task)
      .catch(() => {})
      .finally(() => {
        inFlight = false
        if (!pending) {
          return
        }
        pending = false
        run()
      })
  }

  return {
    request: () => {
      if (inFlight) {
        pending = true
        return
      }
      run()
    }
  }
}
