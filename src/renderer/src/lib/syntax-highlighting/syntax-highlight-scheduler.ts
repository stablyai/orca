import { yieldToEventLoop } from '../../../../shared/event-loop-yield'

/** Runs for at most `budgetMs`; true once its work is finished. */
export type SyntaxHighlightJob = (budgetMs: number) => boolean

// Tokenizing runs on the renderer thread, so every block together gets one slice shorter than a frame.
const SLICE_BUDGET_MS = 6

const jobs = new Set<SyntaxHighlightJob>()
let running = false

async function runJobs(): Promise<void> {
  running = true
  try {
    while (jobs.size > 0) {
      await yieldToEventLoop()
      const deadline = performance.now() + SLICE_BUDGET_MS
      // A snapshot, so a job sent to the back waits for the next slice.
      for (const job of Array.from(jobs)) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) {
          break
        }
        if (!jobs.has(job)) {
          continue
        }
        let finished = true
        try {
          finished = job(remaining)
        } catch {
          // The lines colored so far stay; the rest keeps its plain text.
        }
        jobs.delete(job)
        if (!finished) {
          // Why: to the back, so a long block cannot starve the others.
          jobs.add(job)
        }
      }
    }
  } finally {
    running = false
  }
}

/** Shares one time slice per task across every block still highlighting; returns a cancel. */
export function scheduleSyntaxHighlighting(job: SyntaxHighlightJob): () => void {
  jobs.add(job)
  if (!running) {
    void runJobs()
  }
  return () => {
    jobs.delete(job)
  }
}
