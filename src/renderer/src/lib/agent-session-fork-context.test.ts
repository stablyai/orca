import { describe, expect, it } from 'vitest'
import {
  buildBoundedSessionTranscript,
  buildFullSessionTranscript
} from './agent-session-fork-context'

describe('agent session fork context', () => {
  it('keeps the full cleaned transcript for Copy Context (#10395)', () => {
    // Why: fork prompts still budget-trim; Copy Context must retain early turns
    // so paste targets get the complete session, not a newest-only slice.
    const early = `EARLY_MARKER ${'x'.repeat(40_000)}`
    const late = '\nLATE_MARKER end of session'
    const full = buildFullSessionTranscript(`${early}${late}`)
    const bounded = buildBoundedSessionTranscript(`${early}${late}`)

    expect(full).toContain('EARLY_MARKER')
    expect(full).toContain('LATE_MARKER')
    expect(full).not.toContain('Earlier terminal output omitted')
    expect(bounded).toContain('Earlier terminal output omitted')
    expect(bounded).not.toContain('EARLY_MARKER')
    expect(bounded).toContain('LATE_MARKER')
  })

  it('returns null from the full transcript when nothing survives cleanup', () => {
    expect(buildFullSessionTranscript('\x1b[0m\r\n\x1bc\x07')).toBeNull()
  })
})
