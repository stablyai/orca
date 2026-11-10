// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OverviewHost } from './agent-accounts-overview-model'

const refresh = vi.fn(async (_id: string) => ({
  checkedAt: 1,
  agents: [{ agent: 'claude' as const, state: 'signedIn' as const }]
}))
vi.mock('@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client', () => ({
  readHostAgentSignInReport: () => null,
  refreshHostAgentSignInReport: (id: string) => refresh(id)
}))
const local = vi.fn(async () => ({ checkedAt: 1, agents: [] }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: () => local()
}))

const { expiredAgents, overviewProbeTargets, runLimited, useOverviewProbes } =
  await import('./use-overview-probes')

function host(over: Partial<OverviewHost> & Pick<OverviewHost, 'hostId' | 'kind'>): OverviewHost {
  return {
    label: over.hostId,
    availability: 'available',
    health: 'available',
    environmentId: over.hostId,
    ...over
  }
}

const HOSTS: OverviewHost[] = [
  host({ hostId: 'local', kind: 'local', environmentId: null }),
  host({ hostId: 'runtime:awake', kind: 'paired' }),
  host({ hostId: 'runtime:wsl', kind: 'wsl', availability: 'stopped' }),
  host({ hostId: 'runtime:vm', kind: 'recipe', availability: 'suspended' }),
  host({ hostId: 'runtime:far', kind: 'paired', availability: 'unreachable' }),
  host({ hostId: 'runtime:ssh', kind: 'sshOrcad', availability: 'disconnected' }),
  host({ hostId: 'ssh:classic', kind: 'sshClassic', environmentId: null })
]

describe('S3 probes', () => {
  it('asks only awake, connected hosts; never a stopped, suspended, unreachable or disconnected one', async () => {
    expect(overviewProbeTargets(HOSTS).map((entry) => entry.hostId)).toEqual([
      'local',
      'runtime:awake'
    ])
    const { result } = renderHook(() => useOverviewProbes(HOSTS))
    await waitFor(() => expect(result.current.firstPassDone).toBe(true))
    expect(refresh.mock.calls.map(([id]) => id)).toEqual(['runtime:awake'])
    expect(local).toHaveBeenCalledTimes(1)
    expect(result.current.probes['runtime:wsl']?.checking).toBe(false)
  })

  it('keeps at most four asks in flight', async () => {
    let inFlight = 0
    let peak = 0
    await runLimited(
      Array.from({ length: 10 }, (_, index) => index),
      4,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Promise.resolve()
        inFlight -= 1
      }
    )
    expect(peak).toBe(4)
  })

  it('derives "Sign-in expired" from the last cached verdict', () => {
    expect(
      expiredAgents(
        { checkedAt: 1, agents: [{ agent: 'codex', state: 'signedIn' }] },
        { checkedAt: 2, agents: [{ agent: 'codex', state: 'signedOut' }] }
      )
    ).toEqual(['codex'])
    expect(
      expiredAgents(null, { checkedAt: 2, agents: [{ agent: 'codex', state: 'signedOut' }] })
    ).toEqual([])
  })
})
