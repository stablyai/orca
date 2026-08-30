import { describe, expect, it } from 'vitest'
import {
  buildPtyProcessInspectionWireResult,
  composeLegacyPtyProcessInspection,
  readPtyProcessInspectionEvidence,
  readPtyProcessInspectionEvidenceForAbsenceAction,
  type PtyProcessInspectionEvidence
} from './pty-process-inspection-evidence'

// Pins the normalize funnel at the contract level, independent of any
// consumer's own polarity guard: a foreign host's out-of-contract or
// malformed evidence must coerce to 'unverifiable', never pass through
// as something a consumer could mistake for an observation.
describe('readPtyProcessInspectionEvidence normalization', () => {
  it('coerces an out-of-contract children verdict to unverifiable', () => {
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: null },
        children: { verdict: 'someday-new-verdict' } as never
      }
    })
    expect(evidence.children).toEqual({
      verdict: 'unverifiable',
      reason: 'malformed child-process inspection evidence'
    })
  })

  it('coerces an out-of-contract foreground verdict to unverifiable', () => {
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'someday-new-verdict' } as never,
        children: { verdict: 'exited' }
      }
    })
    expect(evidence.foreground).toEqual({
      verdict: 'unverifiable',
      reason: 'malformed foreground inspection evidence'
    })
  })

  it('defaults a missing unverifiable reason instead of trusting the shape', () => {
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable' },
        children: { verdict: 'unverifiable' }
      } as PtyProcessInspectionEvidence
    })
    expect(evidence.foreground).toEqual({ verdict: 'unverifiable', reason: 'unspecified' })
    expect(evidence.children).toEqual({ verdict: 'unverifiable', reason: 'unspecified' })
  })

  it('coerces an observed verdict with a non-string processName to unverifiable', () => {
    // A number here would flow into recognizeAgentProcess and count toward the
    // "foreground is not a recognized agent" leg — malformed foreign data must
    // never feed the positive-exited path.
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'observed', processName: 42 } as never,
        children: { verdict: 'exited' }
      }
    })
    expect(evidence.foreground).toEqual({
      verdict: 'unverifiable',
      reason: 'malformed foreground inspection evidence'
    })
  })

  it('replaces a non-string unverifiable reason instead of forwarding it', () => {
    const evidence = readPtyProcessInspectionEvidence({
      foregroundProcess: null,
      hasChildProcesses: false,
      processEvidence: {
        foreground: { verdict: 'unverifiable', reason: 42 } as never,
        children: { verdict: 'unverifiable', reason: { deep: true } } as never
      }
    })
    expect(evidence.foreground).toEqual({ verdict: 'unverifiable', reason: 'unspecified' })
    expect(evidence.children).toEqual({ verdict: 'unverifiable', reason: 'unspecified' })
  })

  it('synthesizes the legacy reading when the host predates evidence', () => {
    expect(
      readPtyProcessInspectionEvidence({ foregroundProcess: 'codex', hasChildProcesses: true })
    ).toEqual({
      foreground: { verdict: 'observed', processName: 'codex' },
      children: { verdict: 'live' }
    })
    expect(
      readPtyProcessInspectionEvidence({ foregroundProcess: null, hasChildProcesses: false })
    ).toEqual({
      foreground: { verdict: 'observed', processName: null },
      children: { verdict: 'exited' }
    })
  })
})

// The one rule both terminal close guards read the verdict through. It lives here
// rather than in either guard so there is a single implementation to drift from:
// the guards contributed three of the last four divergences by each growing their
// own arm for a shape like this one.
describe('readPtyProcessInspectionEvidenceForAbsenceAction', () => {
  it('never lets a host that published nothing state an exit', () => {
    // The exact payload a retained pre-v27 daemon returns from `inspectProcess`.
    const evidence = readPtyProcessInspectionEvidenceForAbsenceAction(
      composeLegacyPtyProcessInspection('zsh')
    )

    expect(
      readPtyProcessInspectionEvidence(composeLegacyPtyProcessInspection('zsh')).children
    ).toEqual({ verdict: 'exited' })
    expect(evidence.children.verdict).toBe('unverifiable')
    expect(evidence.foreground.verdict).toBe('unverifiable')
  })

  it('degrades an unpublished null foreground rather than reading it as an observation', () => {
    const evidence = readPtyProcessInspectionEvidenceForAbsenceAction({
      foregroundProcess: null,
      hasChildProcesses: false
    })

    expect(evidence).toEqual({
      foreground: { verdict: 'unverifiable', reason: expect.any(String) },
      children: { verdict: 'unverifiable', reason: expect.any(String) }
    })
  })

  // The positive survives: it is the only thing such a host can say without ambiguity,
  // and believing it only ever adds caution on the paths that act on absence.
  it('keeps the positives an unpublished host can still state', () => {
    expect(
      readPtyProcessInspectionEvidenceForAbsenceAction(composeLegacyPtyProcessInspection('codex'))
    ).toEqual({
      foreground: { verdict: 'observed', processName: 'codex' },
      children: { verdict: 'live' }
    })
  })

  // A published verdict is passed through untouched in both directions — the rule
  // above must not reach a host that DID state what it observed.
  it('leaves every published verdict exactly as the host stated it', () => {
    for (const children of [
      { verdict: 'exited' } as const,
      { verdict: 'live' } as const,
      { verdict: 'unverifiable', reason: 'ps timed out' } as const
    ]) {
      const published = buildPtyProcessInspectionWireResult(
        { verdict: 'observed', processName: 'zsh' },
        children
      )

      expect(readPtyProcessInspectionEvidenceForAbsenceAction(published)).toEqual(
        readPtyProcessInspectionEvidence(published)
      )
      expect(readPtyProcessInspectionEvidenceForAbsenceAction(published).children).toEqual(children)
    }
  })
})
