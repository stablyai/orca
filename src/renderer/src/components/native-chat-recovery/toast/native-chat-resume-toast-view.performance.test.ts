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

/** Counts every element read of the run's entries, however the derivation walks them. */
function countingEntries(entries: ResumeRun['entries']) {
  let reads = 0
  const proxy = new Proxy([...entries], {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) {
        reads += 1
      }
      return Reflect.get(target, key, receiver)
    }
  })
  return { proxy, reads: () => reads }
}

describe('resume toast view work', () => {
  it('reads a settled run of refusals without a record a linear number of times', () => {
    const ids = Array.from({ length: N }, (_, index) => `chat-${index}`)
    const counted = countingEntries(ids.map((id) => ({ candidate: chat(id) })))
    const run: ResumeRun = {
      startedAt: 1,
      startedBy: 'launch',
      entries: counted.proxy,
      inFlight: false,
      continued: ids.map((sessionId) => ({ sessionId, outcome: 'refused' as const }))
    }

    const view = resumeToastView(run, [], resumeRunFailures(run, []))

    expect(view.counts.needsYou).toBe(N)
    // Three linear passes at most (failures, run view, refusal join); the quadratic join read ~2.1M.
    expect(counted.reads()).toBeLessThanOrEqual(3 * N)
  })
})
