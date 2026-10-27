import { describe, expect, it } from 'vitest'
import { resolveProgramStatusPresentation } from './presentation'
import type { ProgramStatusFacet } from './facet'

const facet = (overrides: Partial<ProgramStatusFacet>): ProgramStatusFacet => ({
  state: 'working',
  observedAt: 1,
  ...overrides
})

describe('resolveProgramStatusPresentation', () => {
  it('shows nothing without a facet', () => {
    expect(resolveProgramStatusPresentation({ state: 'working' })).toEqual({})
  })

  it('shows progress and the program line on a live row', () => {
    expect(
      resolveProgramStatusPresentation({
        state: 'working',
        programStatus: facet({ progress: 40, message: 'Pushing image' })
      })
    ).toEqual({ progress: 40, message: 'Pushing image' })
  })

  it("lets a hook's structured tool preview win over the program's free text", () => {
    expect(
      resolveProgramStatusPresentation({
        state: 'working',
        toolName: 'Edit',
        programStatus: facet({ progress: 40, message: 'Editing files' })
      })
    ).toEqual({ progress: 40 })
  })

  it('never paints a finished row with a stale live facet', () => {
    expect(
      resolveProgramStatusPresentation({
        state: 'done',
        programStatus: facet({ progress: 90, message: 'Almost there' })
      })
    ).toEqual({})
  })

  it('raises attention for a block the row state does not show (sign-in after a hook turn)', () => {
    expect(
      resolveProgramStatusPresentation({
        state: 'done',
        programStatus: facet({ state: 'blocked', kind: 'auth', message: 'Session expired' })
      })
    ).toEqual({ attention: { kind: 'auth', message: 'Session expired' } })
    expect(
      resolveProgramStatusPresentation({
        state: 'waiting',
        programStatus: facet({ state: 'blocked', kind: 'permission' })
      }).attention
    ).toBeUndefined()
  })
})
