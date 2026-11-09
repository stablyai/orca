import { describe, expect, it, vi } from 'vitest'

vi.mock('@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client', () => {
  const report = { checkedAt: 0, agents: [{ agent: 'claude', state: 'signedOut' }] }
  return {
    readHostAgentSignInReport: () => null,
    refreshHostAgentSignInReport: async () => report,
    hostAgentSignInEntry: (value: typeof report | null, agent: string) =>
      value?.agents.find((entry) => entry.agent === agent) ?? null
  }
})
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

const request = (key: string) => ({
  key,
  environmentId: 'env-1',
  hostLabel: 'devbox',
  agent: 'claude' as const,
  prompt: null
})

describe('agent sign-in gate', () => {
  it('holds every pane launching the agent on that host behind one sign-in', async () => {
    const first = requireAgentSignIn(request('pane-a'))
    await vi.waitFor(() => expect(readAgentSignInGate('pane-a')).not.toBeNull())
    const second = requireAgentSignIn(request('pane-b'))
    await vi.waitFor(() => expect(readAgentSignInGate('pane-b')).not.toBeNull())
    const entry = agentSignInGateEntry('pane-a')
    expect(agentSignInGateEntry('pane-b')).toBe(entry)

    // One pane leaving keeps the sign-in for the other.
    expect(releaseAgentSignInPane('pane-a', 'cancel')).toBe(false)
    await expect(first).resolves.toBe('cancel')
    expect(readAgentSignInGate('pane-a')).toBeNull()
    expect(readAgentSignInGate('pane-b')).not.toBeNull()

    settleAgentSignInGate(entry!, 'proceed')
    await expect(second).resolves.toBe('proceed')
    expect(readAgentSignInGate('pane-b')).toBeNull()
  })
})
