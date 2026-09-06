import { ProcessTableCaptureError } from './process-table-snapshot'

/** How long an evidence-publishing read waits for the shared capture before giving up on it.
 *
 *  Sized from both ends rather than picked. The floor is what the capture costs: the `command=`
 *  column measured 1.15s for 1,948 processes on an idle host, so a budget under that answers
 *  `unverifiable` about a machine nobody is straining. The ceiling is the consumer's --
 *  `REMOTE_FOREGROUND_EVIDENCE_MAX_AGE_MS` is 2,000ms and a TTL-shared capture may already be
 *  500ms old when it is served, which leaves 1,500ms, and transit takes the rest.
 *
 *  Deliberately an order of magnitude below the process-capture timeout, because the two answer
 *  different questions. Identity proof asks whether a process exists and must not read a slow
 *  capture as an absent one, so it waits. These consumers ask whether an observation describes
 *  NOW, and on a host where the capture costs more than this, it does not: the same capture
 *  measured 4.0-18.6s at load 46, and 2.5-9.0s on an idle 2,002-process laptop. A late answer is
 *  rejected by the age gate anyway, having first blocked a polled path for the whole capture, so
 *  a prompt `unverifiable` is both the truthful verdict and the cheaper one. */
export const PROCESS_TABLE_EVIDENCE_BUDGET_MS = 1_200

/** Bounds the wait, never the shared capture that continues to fill the cache. */
export async function withEvidenceBudget<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new ProcessTableCaptureError('capture_over_budget')),
          PROCESS_TABLE_EVIDENCE_BUDGET_MS
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
