import { describe, expect, it, vi } from 'vitest'
import type { WorktreeCreationRequest } from '@/lib/workspace/creation/pending-worktree-creation'

const signedOutOn = vi.hoisted(() => vi.fn<(environmentId: string) => Promise<boolean>>())
vi.mock('./agent-sign-in-gate-store', () => ({
  isAgentSignedOutOnHost: (environmentId: string) => signedOutOn(environmentId)
}))
const cloudHold = vi.hoisted(() => ({
  cloud: false,
  decision: 'start' as 'start' | 'hold',
  asked: 0
}))
vi.mock('@/lib/orca-cloud/orca-cloud-environment-id', () => ({
  isOrcaCloudEnvironmentId: () => cloudHold.cloud
}))
vi.mock('@/lib/orca-cloud/cloud-agent-launch-hold', () => ({
  cloudAgentLaunchDecision: async () => {
    cloudHold.asked += 1
    return cloudHold.decision
  }
}))
vi.mock('@/lib/workspace/creation/worktree-creation-host-agent-launch', () => ({
  hostPlannableAgentLaunch: () => ({ agent: 'claude' })
}))

const { hostSignInCheck, signedInHostLaunch } = await import('./host-agent-launch-sign-in')

const onHost = (hostId: string | null): WorktreeCreationRequest =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only host and agent are read.
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

describe('PC-3b: a create on Orca Cloud whose account would hold', () => {
  it('plans the launch in the pane (held, prompt kept) instead of letting the host start it', async () => {
    signedOutOn.mockReset()
    cloudHold.cloud = true
    cloudHold.decision = 'hold'
    const request = onHost('runtime:env-cloud')
    await expect(
      signedInHostLaunch(request, Promise.resolve(false), request)
    ).resolves.toBeUndefined()
  })

  it('keeps the faster host-planned launch once the account is set up', async () => {
    cloudHold.cloud = true
    cloudHold.decision = 'start'
    const request = onHost('runtime:env-cloud')
    await expect(signedInHostLaunch(request, Promise.resolve(false), request)).resolves.toEqual({
      agent: 'claude'
    })
  })

  it('never asks the Orca account for a host that is not Orca Cloud', async () => {
    cloudHold.cloud = false
    cloudHold.decision = 'hold'
    cloudHold.asked = 0
    const request = onHost('runtime:env-1')
    await expect(signedInHostLaunch(request, Promise.resolve(false), request)).resolves.toEqual({
      agent: 'claude'
    })
    expect(cloudHold.asked).toBe(0)
  })
})
