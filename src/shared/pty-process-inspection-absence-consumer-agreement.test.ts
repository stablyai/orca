import { describe, expect, it } from 'vitest'
import {
  hasPublishedPtyProcessInspectionEvidence,
  readPtyProcessInspectionEvidence,
  readPtyProcessInspectionEvidenceForAbsenceAction,
  type PtyProcessInspectionEvidence
} from './pty-process-inspection-evidence'

type Inspection = {
  foregroundProcess: string | null
  hasChildProcesses: boolean
  processEvidence?: PtyProcessInspectionEvidence
}
type Outcome = 'unverifiable' | { processName: string | null; children: string }

// The rule as `probeTerminalLiveness` spells it inline today.
function openCoded(inspection: Inspection): Outcome {
  const evidence = readPtyProcessInspectionEvidence(inspection)
  if (
    evidence.foreground.verdict === 'unverifiable' ||
    evidence.children.verdict === 'unverifiable'
  ) {
    return 'unverifiable'
  }
  if (
    !hasPublishedPtyProcessInspectionEvidence(inspection) &&
    evidence.children.verdict !== 'live'
  ) {
    return 'unverifiable'
  }
  return {
    processName:
      evidence.foreground.verdict === 'observed' ? evidence.foreground.processName : null,
    children: evidence.children.verdict
  }
}

// The same rule read off the shared absence-action reader.
function shared(inspection: Inspection): Outcome {
  const evidence = readPtyProcessInspectionEvidenceForAbsenceAction(inspection)
  if (
    evidence.foreground.verdict === 'unverifiable' ||
    evidence.children.verdict === 'unverifiable'
  ) {
    return 'unverifiable'
  }
  return {
    processName:
      evidence.foreground.verdict === 'observed' ? evidence.foreground.processName : null,
    children: evidence.children.verdict
  }
}

const FOREGROUNDS: unknown[] = [
  { verdict: 'observed', processName: null },
  { verdict: 'observed', processName: 'zsh' },
  { verdict: 'observed', processName: 'codex' },
  { verdict: 'observed', processName: 7 },
  { verdict: 'unverifiable', reason: 'ps timed out' },
  { verdict: 'unverifiable', reason: 9 },
  { verdict: 'someday-new-verdict' },
  undefined
]
const CHILDREN: unknown[] = [
  { verdict: 'live' },
  { verdict: 'exited' },
  { verdict: 'unverifiable', reason: 'pgrep missing' },
  { verdict: 'unverifiable', reason: null },
  { verdict: 'someday-new-verdict' },
  {},
  undefined
]
const LEGACY_NAMES = [null, 'zsh', 'bash', 'codex', '']
const LEGACY_CHILDREN = [true, false]

// STA-5901: the consumers that act on absence — both terminal close guards, the
// completion monitor and the workspace-cleanup liveness probe — must reach the
// same verdict for the same inspection. `probeTerminalLiveness` spelled the rule
// inline until it was collapsed onto the shared reader; this enumerates the whole
// verdict space so a future re-spelling cannot drift from it silently.
describe('the absence-action rule against the reading it replaced', () => {
  it('agrees on every enumerated inspection shape', () => {
    const divergences: string[] = []
    let count = 0
    const evidenceShapes: (PtyProcessInspectionEvidence | undefined)[] = [undefined]
    for (const foreground of FOREGROUNDS) {
      for (const children of CHILDREN) {
        evidenceShapes.push({ foreground, children } as PtyProcessInspectionEvidence)
      }
    }
    for (const processEvidence of evidenceShapes) {
      for (const foregroundProcess of LEGACY_NAMES) {
        for (const hasChildProcesses of LEGACY_CHILDREN) {
          const inspection: Inspection = {
            foregroundProcess,
            hasChildProcesses,
            ...(processEvidence === undefined ? {} : { processEvidence })
          }
          count += 1
          const a = JSON.stringify(openCoded(inspection))
          const b = JSON.stringify(shared(inspection))
          if (a !== b) {
            divergences.push(`${JSON.stringify(inspection)} open=${a} shared=${b}`)
          }
        }
      }
    }
    console.log(`enumerated inputs: ${count}, divergences: ${divergences.length}`)
    expect({ count, divergences }).toEqual({ count, divergences: [] })
    expect(count).toBeGreaterThanOrEqual(533)
  })
})
