import { describe, expect, it } from 'vitest'
import { resolvePaneLinkCwd } from './pane-link-cwd'

describe('resolvePaneLinkCwd', () => {
  it('prefers the pane-specific cwd when one has been seeded or confirmed', () => {
    expect(
      resolvePaneLinkCwd(
        new Map([[2, { cwd: '/repo/packages/web', confirmed: false }]]),
        2,
        '/repo'
      )
    ).toBe('/repo/packages/web')
  })

  it('falls back to the lifecycle startup cwd when the pane has no cached cwd yet', () => {
    expect(resolvePaneLinkCwd(new Map(), 2, '/repo')).toBe('/repo')
  })
})
