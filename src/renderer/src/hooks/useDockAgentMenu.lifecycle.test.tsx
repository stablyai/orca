// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  DashboardRevealAgentArgs,
  DashboardSnapshot
} from '../../../shared/dashboard-snapshot'

const mocks = vi.hoisted(() => {
  const offStore = vi.fn()
  const offOpen = vi.fn()
  return {
    platform: 'darwin',
    webClient: false,
    state: { agentStatusEpoch: 0, unreadTerminalTabs: {} },
    offStore,
    offOpen,
    subscribe: vi.fn((_listener: (state: unknown, previousState: unknown) => void) => offStore),
    setDockAgentMenu: vi.fn(async (_payload: unknown) => undefined),
    onOpenDockAgent: vi.fn((_callback: (args: DashboardRevealAgentArgs) => void) => offOpen),
    buildDashboardSnapshot: vi.fn(
      (_state: unknown, now: number, _options: Record<string, unknown>): DashboardSnapshot => ({
        generatedAt: now,
        cards: []
      })
    ),
    revealDashboardAgent: vi.fn()
  }
})

vi.mock('@/store', () => ({
  useAppStore: { getState: () => mocks.state, subscribe: mocks.subscribe }
}))
vi.mock('@/components/dashboard/build-dashboard-snapshot', () => ({
  buildDashboardSnapshot: mocks.buildDashboardSnapshot
}))
vi.mock('@/components/dashboard/reveal-dashboard-agent', () => ({
  revealDashboardAgent: mocks.revealDashboardAgent
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.webClient }))

import { useDockAgentMenu } from './useDockAgentMenu'

function Harness(): null {
  useDockAgentMenu()
  return null
}

describe('useDockAgentMenu lifecycle', () => {
  let root: Root

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    mocks.platform = 'darwin'
    mocks.webClient = false
    mocks.state = { agentStatusEpoch: 0, unreadTerminalTabs: {} }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        platform: { get: () => ({ platform: mocks.platform }) },
        app: { setDockAgentMenu: mocks.setDockAgentMenu, onOpenDockAgent: mocks.onOpenDockAgent }
      }
    })
    root = createRoot(document.createElement('div'))
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    vi.useRealTimers()
  })

  it.each([
    { platform: 'linux', webClient: false },
    { platform: 'darwin', webClient: true }
  ])('does no background work on $platform with webClient=$webClient', async (client) => {
    Object.assign(mocks, client)
    await act(async () => root.render(<Harness />))

    expect(mocks.subscribe).not.toHaveBeenCalled()
    expect(mocks.onOpenDockAgent).not.toHaveBeenCalled()
    expect(mocks.buildDashboardSnapshot).not.toHaveBeenCalled()
  })

  it('throttles relevant updates and ignores review and launcher state', async () => {
    await act(async () => root.render(<Harness />))
    expect(mocks.buildDashboardSnapshot).toHaveBeenCalledWith(
      mocks.state,
      expect.any(Number),
      expect.objectContaining({
        includeCardDetails: false,
        includeFilterOptions: false,
        includeExecutionHostId: true
      })
    )
    const listener = mocks.subscribe.mock.calls[0]?.[0]
    if (!listener) {
      throw new Error('Dock store subscription was not registered')
    }
    listener({ ...mocks.state, prCache: { review: {} }, detectedAgentIds: ['codex'] }, mocks.state)
    await act(async () => vi.advanceTimersByTime(200))
    expect(mocks.setDockAgentMenu).toHaveBeenCalledTimes(1)

    for (let epoch = 1; epoch <= 5; epoch++) {
      const previousState = mocks.state
      mocks.state = { ...previousState, agentStatusEpoch: epoch }
      listener(mocks.state, previousState)
    }
    await act(async () => vi.advanceTimersByTime(199))
    expect(mocks.setDockAgentMenu).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTime(1))
    expect(mocks.setDockAgentMenu).toHaveBeenCalledTimes(2)
    expect(mocks.buildDashboardSnapshot.mock.calls.at(-1)?.[2].rowsGeneration).toBe(5)
  })

  it('routes clicks through existing activation and cancels pending work on unmount', async () => {
    await act(async () => root.render(<Harness />))
    const target = {
      repoId: 'folder-workspace:project',
      worktreeId: 'folder-workspace:docs',
      executionHostId: 'ssh:builder' as const,
      tabId: 'remote-tab',
      leafId: 'remote-leaf'
    }
    mocks.onOpenDockAgent.mock.calls[0]?.[0](target)
    expect(mocks.revealDashboardAgent).toHaveBeenCalledWith(target)

    mocks.subscribe.mock.calls[0]?.[0]({ ...mocks.state, agentStatusEpoch: 1 }, mocks.state)
    await act(async () => root.unmount())
    await act(async () => vi.advanceTimersByTime(200))
    expect(mocks.offStore).toHaveBeenCalledTimes(1)
    expect(mocks.offOpen).toHaveBeenCalledTimes(1)
    expect(mocks.setDockAgentMenu).toHaveBeenCalledTimes(1)
  })
})
