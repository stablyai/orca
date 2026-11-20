import { describe, expect, it } from 'vitest'
import type { ResumeCandidate } from '../tree/native-chat-resume-on-restart-grouping'
import type { ResumeRun } from '../runs/native-chat-resume-run'
import { resumeRunFailures } from '../runs/native-chat-resume-run-view'
import { resumeToastView } from './native-chat-resume-toast-view'

// Guards #44806 review RT-C1-01: refused outcomes were joined to the run with one scan each,
// N(N+1)/2 entry reads for a settled run of N refusals. The toast must stay linear.

const N = 2048

function chat(sessionId: string): ResumeCandidate {
  return {
    sessionId,
    workspaceId: 'repo::/repo',
    agent: 'codex',
    trigger: 'update',
    latestPrompt: 'fix the build',
    recordedAt: 1
  }
}

/** Counts every read of an entry's chat, however the derivation walks the run. */
function countingEntries(ids: readonly string[]) {
  let reads = 0
  const entries: ResumeRun['entries'] = ids.map((id) => {
    const candidate = chat(id)
    return {
      get candidate() {
        reads += 1
        return candidate
      }
    }
  })
  return { entries, reads: () => reads }
}

describe('resume toast view work', () => {
  it('reads a settled run of refusals without a record a linear number of times', () => {
    const ids = Array.from({ length: N }, (_, index) => `chat-${index}`)
    const counted = countingEntries(ids)
    const run: ResumeRun = {
      startedAt: 1,
      startedBy: 'launch',
      entries: counted.entries,
      inFlight: false,
      continued: ids.map((sessionId) => ({ sessionId, outcome: 'refused' as const }))
    }

    const view = resumeToastView(run, [], resumeRunFailures(run, []))

    expect(view.counts.needsYou).toBe(N)
    // A few reads per entry across linear passes; the per-refusal scan it replaced read ~2.1M.
    expect(counted.reads()).toBeLessThanOrEqual(4 * N)
  })
})
