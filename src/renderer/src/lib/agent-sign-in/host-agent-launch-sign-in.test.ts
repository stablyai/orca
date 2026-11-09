import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'

const signedOutOn = vi.hoisted(() => vi.fn<(environmentId: string) => Promise<boolean>>())
vi.mock('./agent-sign-in-gate-store', () => ({
  isAgentSignedOutOnHost: (environmentId: string) => signedOutOn(environmentId)
}))
vi.mock('@/lib/workspace/creation/worktree-creation-host-agent-launch', () => ({
  hostPlannableAgentLaunch: () => ({ agent: 'claude' })
}))

const { hostSignInCheck, signedInHostLaunch } = await import('./host-agent-launch-sign-in')

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only host and agent are read.
const onHost = (hostId: string | null) =>
  ({ agent: 'claude', executionHostId: hostId }) as WorktreeCreationRequest

describe('host-started agent launch on a new VM', () => {
  it('asks the VM itself once it exists, since the early ask had no host', async () => {
    signedOutOn.mockImplementation(async (environmentId) => environmentId === 'env-vm')
    const before = onHost(null)
    const early = hostSignInCheck(before)
    await expect(early).resolves.toBe(false)

    // Signed out on the VM: the pane plans the launch so it can show the sign-in card.
    await expect(
      signedInHostLaunch(onHost('runtime:env-vm'), early, before)
    ).resolves.toBeUndefined()
  })

  it('reuses the early answer when the host did not change', async () => {
    signedOutOn.mockReset()
    signedOutOn.mockResolvedValue(true)
    const request = onHost('runtime:env-1')
    await expect(signedInHostLaunch(request, Promise.resolve(false), request)).resolves.toEqual({
      agent: 'claude'
    })
    expect(signedOutOn).not.toHaveBeenCalled()
  })
})
