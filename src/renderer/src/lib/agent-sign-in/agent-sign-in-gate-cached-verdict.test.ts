import { beforeEach, describe, expect, it, vi } from 'vitest'

type Report = { checkedAt: number; agents: { agent: string; state: string }[] }
const signedOut: Report = { checkedAt: 0, agents: [{ agent: 'claude', state: 'signedOut' }] }
const signedIn: Report = { checkedAt: 0, agents: [{ agent: 'claude', state: 'signedIn' }] }

const status = vi.hoisted(() => ({
  fresh: null as Report | null,
  refresh: vi.fn<() => Promise<Report | null>>()
}))

vi.mock('@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client', () => ({
  readHostAgentSignInReport: () => status.fresh,
  readFreshHostAgentSignInReport: () => status.fresh,
  refreshHostAgentSignInReport: status.refresh,
  hostAgentSignInEntry: (value: Report | null, agent: string) =>
    value?.agents.find((entry) => entry.agent === agent) ?? null
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: async () => true
}))

const {
  agentSignInGateEntry,
  readAgentSignInGate,
  releaseAgentSignInPane,
  requireAgentSignIn,
  settleAgentSignInGate
} = await import('./agent-sign-in-gate-store')

const request = (key: string, background = false) => ({
  key,
  environmentId: 'env-1',
  hostLabel: 'devbox',
  agent: 'claude' as const,
  prompt: null,
  background
})

describe('agent sign-in gate with a connect-time verdict', () => {
  beforeEach(() => {
    status.fresh = null
    status.refresh.mockReset()
  })

  it('shows the card at once from a recent signed-out verdict, without waiting on the host', async () => {
    status.fresh = signedOut
    status.refresh.mockReturnValue(new Promise(() => {}))
    const held = requireAgentSignIn(request('pane-a'))
    await vi.waitFor(() => expect(readAgentSignInGate('pane-a')?.view.step).toBe('need'))
    settleAgentSignInGate(agentSignInGateEntry('pane-a')!, 'cancel')
    await expect(held).resolves.toBe('cancel')
  })

  it('lets the launch go when the host has since been signed in', async () => {
    status.fresh = signedOut
    status.refresh.mockResolvedValue(signedIn)
    await expect(requireAgentSignIn(request('pane-b'))).resolves.toBe('proceed')
    expect(readAgentSignInGate('pane-b')).toBeNull()
  })

  it('a sign-in the build sheet started keeps going when a pane leaves it', async () => {
    status.refresh.mockResolvedValue(signedOut)
    const sheet = requireAgentSignIn(request('sheet', true))
    await vi.waitFor(() => expect(readAgentSignInGate('sheet')).not.toBeNull())
    const pane = requireAgentSignIn(request('pane-c'))
    await vi.waitFor(() => expect(readAgentSignInGate('pane-c')).not.toBeNull())

    expect(releaseAgentSignInPane('pane-c', 'cancel')).toBe(false)
    await expect(pane).resolves.toBe('cancel')
    settleAgentSignInGate(agentSignInGateEntry('sheet')!, 'cancel')
    await expect(sheet).resolves.toBe('cancel')
  })
})
