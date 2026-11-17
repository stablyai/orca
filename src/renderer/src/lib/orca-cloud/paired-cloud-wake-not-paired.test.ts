// A paired cloud workspace whose pairing is gone can't be woken from here: opening it shows the
// waking card marked not-paired (which offers "Open cloud workspace…"), and never calls wake.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: {} }), subscribe: () => () => {} }
}))

import { wakePairedCloudWorkspace } from './paired-cloud-wake'
import { getCloudWorkspaceSnapshot, seedCloudWorkspaceSnapshot } from './orca-cloud-workspace-store'
import { resetCloudWorkspaceIdentityForTests } from '@/components/cloud-workspaces/cloud-workspace-identity'

const ROW = 'push-test::/workspace/orca-sandbox-push-test'
let wake: ReturnType<typeof vi.fn>

beforeEach(() => {
  resetCloudWorkspaceIdentityForTests()
  seedCloudWorkspaceSnapshot({ paired: { [ROW]: 'env-gone' }, idsLoaded: true })
  wake = vi.fn()
  vi.stubGlobal('window', {
    api: {
      cloudWorkspaces: {
        wake,
        localWorkspaces: async () => [],
        // No binding names this server any more: its pairing was removed.
        environmentBindings: async () => ({})
      }
    }
  })
})

describe('a paired workspace whose pairing is gone', () => {
  it('fails as not paired, with the card that offers Open cloud workspace…', async () => {
    const result = await wakePairedCloudWorkspace(ROW)
    expect(result).toMatchObject({ ok: false, reason: 'not_paired' })
    expect(wake).not.toHaveBeenCalled()
    expect(getCloudWorkspaceSnapshot().wake[ROW]).toMatchObject({
      phase: 'failed',
      notPaired: true
    })
    // The copy points at the picker, never at a Home list that no longer exists.
    expect(getCloudWorkspaceSnapshot().wake[ROW]?.message).not.toMatch(/Home/)
  })

  it('a predictive (quiet) wake leaves no card behind', async () => {
    expect((await wakePairedCloudWorkspace(ROW, { quiet: true })).ok).toBe(false)
    expect(getCloudWorkspaceSnapshot().wake[ROW]).toBeUndefined()
  })
})
