// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { StructuredAgentSessionHostCapabilityState } from '@/runtime/structured-agent-session-host-capability'
import { StatsPane } from './StatsPane'

const SERVER = { kind: 'environment', environmentId: 'env-1' } as const

const storeState: {
  statsHost: RuntimeClientTarget
  statsSummary: null
  setStatsHost: ReturnType<typeof vi.fn>
  fetchStatsSummary: ReturnType<typeof vi.fn>
  recordFeatureInteraction: ReturnType<typeof vi.fn>
} = {
  statsHost: { kind: 'local' },
  statsSummary: null,
  setStatsHost: vi.fn(),
  fetchStatsSummary: vi.fn(),
  recordFeatureInteraction: vi.fn()
}
let hostCapability: StructuredAgentSessionHostCapabilityState = 'unknown'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))
vi.mock('@/runtime/structured-agent-session-host-capability', () => ({
  useStructuredAgentSessionHostCapabilityState: () => hostCapability
}))
vi.mock('./UsageOverviewPane', () => ({
  UsageOverviewPane: () => <div>usage overview</div>
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  storeState.statsHost = { kind: 'local' }
  hostCapability = 'unknown'
})

describe('StatsPane host', () => {
  it('switches the store to the chosen server before any pane reads usage', () => {
    render(<StatsPane host={SERVER} />)

    expect(storeState.setStatsHost).toHaveBeenCalledWith(SERVER)
    expect(screen.queryByText('usage overview')).not.toBeInTheDocument()
    expect(storeState.fetchStatsSummary).not.toHaveBeenCalled()
  })

  it("shows the server's usage once the store reads it and the server can report it", () => {
    storeState.statsHost = SERVER
    hostCapability = 'supported'

    render(<StatsPane host={SERVER} />)

    expect(screen.getByText('usage overview')).toBeInTheDocument()
    expect(storeState.fetchStatsSummary).toHaveBeenCalled()
  })

  it('asks to update a server whose Orca cannot report usage', () => {
    storeState.statsHost = SERVER
    hostCapability = 'unsupported'

    render(<StatsPane host={SERVER} />)

    expect(screen.getByText(/Update Orca on the server/)).toBeInTheDocument()
    expect(screen.queryByText('usage overview')).not.toBeInTheDocument()
  })

  it('reads this computer without waiting on a capability probe', () => {
    render(<StatsPane />)

    expect(screen.getByText('usage overview')).toBeInTheDocument()
  })
})
