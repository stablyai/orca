import { describe, expect, it } from 'vitest'
import { resolveProgramStatusPresentation } from './presentation'
import type { ProgramStatusFacet } from './facet'

const facet = (overrides: Partial<ProgramStatusFacet>): ProgramStatusFacet => ({
  state: 'working',
  observedAt: 1,
  ...overrides
})

describe('resolveProgramStatusPresentation', () => {
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
