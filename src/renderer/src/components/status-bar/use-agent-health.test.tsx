// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentHealthProvider, AgentHealthSnapshot } from '../../../../shared/agent-health'

const mocks = vi.hoisted(() => ({
  probeAgentHealth: vi.fn(),
  probeAgentHealthProvider: vi.fn(),
  updateAgent: vi.fn(async () => ({
    provider: 'codex' as const,
    outcome: 'updated' as const,
    previousVersion: '0.146.1',
    currentVersion: '0.147.0'
  })),
  callRuntimeRpc: vi.fn(),
  getState: vi.fn(() => ({}))
}))

vi.mock('../../store', () => ({
  useAppStore: Object.assign(vi.fn(), { getState: mocks.getState })
}))
vi.mock('@/lib/local-preflight-context', () => ({
  getLocalAgentPreflightContext: () => undefined
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.callRuntimeRpc,
  RuntimeRpcCallError: class extends Error {
    code: string

    constructor(code: string) {
      super(code)
      this.code = code
    }
  }
}))

import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { useAgentHealth } from './use-agent-health'

function snapshot(provider: AgentHealthProvider): AgentHealthSnapshot {
  return {
    provider,
    cliStatus: 'available',
    health: 'healthy',
    version: provider === 'codex' ? '0.146.1' : '1.0.61',
    durationMs: 10,
    checkedAt: 1,
    checks: [{ id: 'cli', status: 'ok' }],
    updateAvailability: 'current',
    updateSupported: true
  }
}

function Harness({
  enabled = true,
  environmentId = null
}: {
  enabled?: boolean
  environmentId?: string | null
}): React.JSX.Element {
  const health = useAgentHealth(environmentId, enabled)
  return (
    <>
      <span data-testid="claude-version">
        {health.snapshots.find((entry) => entry.provider === 'claude')?.version ?? ''}
      </span>
      <span data-testid="codex-version">
        {health.snapshots.find((entry) => entry.provider === 'codex')?.version ?? ''}
      </span>
      <span data-testid="claude-pending">
        {health.pendingProviders.claude ? 'pending' : 'idle'}
      </span>
      <span data-testid="codex-pending">{health.pendingProviders.codex ? 'pending' : 'idle'}</span>
      <span data-testid="update-state">{health.updateStates.codex?.status ?? ''}</span>
      <button type="button" onClick={() => void health.update('codex')}>
        Update
      </button>
    </>
  )
}

describe('useAgentHealth', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    mocks.probeAgentHealth.mockReset()
    mocks.probeAgentHealthProvider.mockReset()
    mocks.probeAgentHealthProvider.mockImplementation(
      async ({ provider }: { provider: AgentHealthProvider }) => snapshot(provider)
    )
    mocks.updateAgent.mockClear()
    mocks.callRuntimeRpc.mockReset()
    window.api = {
      preflight: {
        probeAgentHealth: mocks.probeAgentHealth,
        probeAgentHealthProvider: mocks.probeAgentHealthProvider,
        updateAgent: mocks.updateAgent
      }
    } as never
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.useRealTimers()
  })

  it('probes each provider immediately and then every 15 minutes', async () => {
    await act(async () => root.render(<Harness />))
    expect(mocks.probeAgentHealthProvider).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15 * 60_000)
    })

    expect(mocks.probeAgentHealthProvider).toHaveBeenCalledTimes(4)
  })

  it('publishes a provider result while the other provider is still pending', async () => {
    let resolveClaude: (value: AgentHealthSnapshot) => void = () => {}
    let resolveCodex: (value: AgentHealthSnapshot) => void = () => {}
    mocks.probeAgentHealthProvider.mockImplementation(
      ({ provider }: { provider: AgentHealthProvider }) =>
        new Promise<AgentHealthSnapshot>((resolve) => {
          if (provider === 'claude') {
            resolveClaude = resolve
          } else {
            resolveCodex = resolve
          }
        })
    )

    await act(async () => root.render(<Harness />))
    await act(async () => resolveCodex(snapshot('codex')))

    expect(container.querySelector('[data-testid="codex-version"]')?.textContent).toBe('0.146.1')
    expect(container.querySelector('[data-testid="codex-pending"]')?.textContent).toBe('idle')
    expect(container.querySelector('[data-testid="claude-version"]')?.textContent).toBe('')
    expect(container.querySelector('[data-testid="claude-pending"]')?.textContent).toBe('pending')

    await act(async () => resolveClaude(snapshot('claude')))
  })

  it('waits until the settings target is ready', async () => {
    await act(async () => root.render(<Harness enabled={false} />))

    expect(mocks.probeAgentHealthProvider).not.toHaveBeenCalled()
  })

  it('updates the selected local agent and refreshes only its health', async () => {
    await act(async () => root.render(<Harness />))
    mocks.probeAgentHealthProvider.mockClear()

    await act(async () => {
      container.querySelector('button')?.click()
    })

    expect(mocks.updateAgent).toHaveBeenCalledWith({ provider: 'codex' })
    expect(container.querySelector('[data-testid="update-state"]')?.textContent).toBe('updated')
    expect(mocks.probeAgentHealthProvider).toHaveBeenCalledOnce()
    expect(mocks.probeAgentHealthProvider).toHaveBeenCalledWith({ provider: 'codex' })
  })

  it('falls back to one aggregate probe for an older remote runtime', async () => {
    const snapshots = [snapshot('claude'), snapshot('codex')]
    mocks.callRuntimeRpc.mockImplementation(
      (_target: unknown, method: string): Promise<unknown> =>
        method === 'preflight.probeAgentHealthProvider'
          ? Promise.reject(new RuntimeRpcCallError('method_not_found' as never))
          : Promise.resolve(snapshots)
    )

    await act(async () => root.render(<Harness environmentId="runtime-1" />))

    expect(
      mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'preflight.probeAgentHealth')
    ).toHaveLength(1)
    expect(container.querySelector('[data-testid="claude-version"]')?.textContent).toBe('1.0.61')
    expect(container.querySelector('[data-testid="codex-version"]')?.textContent).toBe('0.146.1')
  })
})
