import { describe, expect, it } from 'vitest'
import { resolveOmpRpcOwnerCwd } from './omp-rpc-owner-cwd'

describe('resolveOmpRpcOwnerCwd', () => {
  it('prefers the owning split pane current cwd over the tab startup cwd', () => {
    expect(
      resolveOmpRpcOwnerCwd({
        paneId: 2,
        paneCwdMap: new Map([[2, { cwd: '/repo/pkg', confirmed: true }]]),
        fallbackCwd: '/repo'
      })
    ).toBe('/repo/pkg')
  })
})
