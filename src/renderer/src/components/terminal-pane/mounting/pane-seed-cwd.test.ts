import { describe, expect, it } from 'vitest'
import { resolvePaneSeedCwd } from './pane-seed-cwd'

describe('resolvePaneSeedCwd', () => {
  it('prefers the inherited split cwd before OSC 7 confirms the pane cwd', () => {
    expect(resolvePaneSeedCwd('/repo/packages/web', '/repo')).toBe('/repo/packages/web')
  })

  it('falls back to the lifecycle cwd when the pane has no split override', () => {
    expect(resolvePaneSeedCwd(undefined, '/repo')).toBe('/repo')
  })
})
