// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDetectedAgents, type UseDetectedAgentsResult } from './useDetectedAgents'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const runtimeEnvironmentCall = vi.fn()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []
let latest: UseDetectedAgentsResult | null = null

function HookProbe(): null {
  latest = useDetectedAgents({ kind: 'runtime', environmentId: 'env-1' })
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderProbe(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe))
  })
  await flushEffects()
}

function environment(pairingRevision: number): PublicKnownRuntimeEnvironment {
  return {
    id: 'env-1',
    name: 'Paired host',
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: 'host'
  }
}

function reply(method: string, result: unknown) {
  return { id: method, ok: true, result, _meta: { runtimeId: 'remote-runtime' } }
}

const STATUS = {
  runtimeId: 'remote-runtime',
  rendererGraphEpoch: 1,
  graphStatus: 'ready',
  authoritativeWindowId: null,
  liveTabCount: 0,
  liveLeafCount: 0,
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
}

function mockHost(detect: (call: number, method: string) => Promise<unknown>): () => number {
  let detectCalls = 0
  runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
    if (method === 'status.get') {
      return Promise.resolve(reply(method, STATUS))
    }
    detectCalls += 1
    return detect(detectCalls, method)
  })
  return () => detectCalls
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState(initialAppState, true)
  latest = null
  runtimeEnvironmentCall.mockReset()
  Object.defineProperty(globalThis.window, 'api', {
    configurable: true,
    value: {
      preflight: { detectAgents: vi.fn(), detectRemoteAgents: vi.fn(), refreshAgents: vi.fn() },
      runtimeEnvironments: { call: runtimeEnvironmentCall },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
})

const LIVE_STATUS: RuntimeStatus = { ...STATUS, graphStatus: 'ready' }

function setHostContact(entry: { live: boolean; hostContactEpoch: number }): void {
  const runtimeStatusByEnvironmentId = new Map(useAppStore.getState().runtimeStatusByEnvironmentId)
  runtimeStatusByEnvironmentId.set('env-1', {
    status: entry.live ? LIVE_STATUS : null,
    checkedAt: entry.hostContactEpoch,
    connectionGeneration: 1,
    hostContactEpoch: entry.hostContactEpoch
  })
  useAppStore.setState({ runtimeStatusByEnvironmentId })
}

describe('useDetectedAgents when the runtime host reconnects', () => {
  it('re-lists agents once contact returns after a failed probe, and not while the host is down', async () => {
    let hostUp = false
    const detectCalls = mockHost((_call, method) =>
      hostUp
        ? Promise.resolve(reply(method, ['codex']))
        : Promise.reject(new Error('The WSL host isn’t connected.'))
    )
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    setHostContact({ live: false, hostContactEpoch: 1 })
    await renderProbe()
    await flushEffects()
    expect(latest?.detectionFailed).toBe(true)
    const failedCalls = detectCalls()

    // A down host is not probed again: re-listing must never boot a stopped distro.
    await act(async () => {
      setHostContact({ live: false, hostContactEpoch: 2 })
    })
    await flushEffects()
    expect(detectCalls()).toBe(failedCalls)
    expect(latest?.detectionFailed).toBe(true)

    hostUp = true
    await act(async () => {
      setHostContact({ live: true, hostContactEpoch: 3 })
    })
    await flushEffects()
    await flushEffects()

    expect(detectCalls()).toBe(failedCalls + 1)
    expect(latest?.detectedIds).toEqual(['codex'])
    expect(latest?.detectionFailed).toBe(false)
  })

  it('re-lists after a reconnect even when the failed probe ran while contact looked live', async () => {
    let hostUp = false
    const detectCalls = mockHost((_call, method) =>
      hostUp
        ? Promise.resolve(reply(method, ['codex']))
        : Promise.reject(new Error('runtime disconnected'))
    )
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    setHostContact({ live: true, hostContactEpoch: 1 })
    await renderProbe()
    await flushEffects()
    expect(latest?.detectionFailed).toBe(true)

    hostUp = true
    await act(async () => {
      setHostContact({ live: true, hostContactEpoch: 2 })
    })
    await flushEffects()
    await flushEffects()

    expect(detectCalls()).toBeGreaterThanOrEqual(2)
    expect(latest?.detectedIds).toEqual(['codex'])
  })
})
