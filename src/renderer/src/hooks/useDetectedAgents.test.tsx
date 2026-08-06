// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  useDetectedAgents,
  type AgentDetectionTarget,
  type UseDetectedAgentsResult
} from './useDetectedAgents'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'

const detectRemoteAgents = vi.fn()
const refreshLocalAgents = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []
let latestHookResult: UseDetectedAgentsResult | null = null

function HookProbe({ target }: { target: AgentDetectionTarget | undefined }): null {
  latestHookResult = useDetectedAgents(target)
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderProbe(target: AgentDetectionTarget | undefined): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { target }))
  })
  await flushEffects()
  return root
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState(initialAppState, true)
  latestHookResult = null
  detectRemoteAgents.mockReset().mockResolvedValue([])
  refreshLocalAgents.mockReset().mockResolvedValue({
    agents: [],
    addedPathSegments: [],
    shellHydrationOk: true,
    pathSource: 'process_env',
    pathFailureReason: 'none'
  })
  runtimeEnvironmentCall.mockReset().mockImplementation(({ method }: { method: string }) => {
    const result =
      method === 'status.get'
        ? {
            runtimeId: 'remote-runtime',
            rendererGraphEpoch: 1,
            graphStatus: 'ready',
            authoritativeWindowId: null,
            liveTabCount: 0,
            liveLeafCount: 0,
            runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
            minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
          }
        : []
    return Promise.resolve({
      id: method,
      ok: true,
      result,
      _meta: { runtimeId: 'remote-runtime' }
    })
  })
  globalThis.window.api = {
    preflight: { detectRemoteAgents, refreshAgents: refreshLocalAgents },
    runtimeEnvironments: { call: runtimeEnvironmentCall }
  } as unknown as Window['api']
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
})

describe('useDetectedAgents (ssh call site)', () => {
  it('fires remote detection once on mount and does not thrash after an empty result', async () => {
    const root = await renderProbe({ kind: 'ssh', connectionId: 'ssh-1' })

    // The effect fires detection once; an empty [] is stored (not null), so the
    // detectedIds===null guard prevents a re-detect loop on the same surface.
    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().remoteDetectedAgentIds['ssh-1']).toEqual([])

    // Re-rendering the same connection must not trigger another probe.
    await act(async () => {
      root.render(createElement(HookProbe, { target: { kind: 'ssh', connectionId: 'ssh-1' } }))
    })
    await flushEffects()

    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
  })

  it('retries a cached empty SSH result when the launch surface is reopened', async () => {
    const firstRoot = await renderProbe({ kind: 'ssh', connectionId: 'ssh-1' })

    expect(detectRemoteAgents).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().remoteDetectedAgentIds['ssh-1']).toEqual([])

    await act(async () => {
      firstRoot.unmount()
    })
    roots.splice(roots.indexOf(firstRoot), 1)
    detectRemoteAgents.mockResolvedValueOnce(['kilo'])

    await renderProbe({ kind: 'ssh', connectionId: 'ssh-1' })

    expect(detectRemoteAgents).toHaveBeenCalledTimes(2)
    expect(useAppStore.getState().remoteDetectedAgentIds['ssh-1']).toEqual(['kilo'])
  })
})

describe('useDetectedAgents (unresolved target)', () => {
  it('does not fall back to detecting or refreshing the local client', async () => {
    await renderProbe(undefined)

    expect(latestHookResult?.detectedIds).toBeNull()
    expect(latestHookResult?.isLoading).toBe(true)
    await expect(latestHookResult?.refresh()).resolves.toEqual([])

    expect(refreshLocalAgents).not.toHaveBeenCalled()
    expect(detectRemoteAgents).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })
})

describe('useDetectedAgents (runtime call site)', () => {
  it('distinguishes an initial remote failure from the pre-effect loading state', async () => {
    runtimeEnvironmentCall.mockRejectedValue(new Error('runtime disconnected'))

    await renderProbe({ kind: 'runtime', environmentId: 'env-1' })

    expect(latestHookResult?.detectedIds).toBeNull()
    expect(latestHookResult?.isLoading).toBe(false)
    expect(latestHookResult?.detectionFailed).toBe(true)
  })

  it('probes each empty runtime target at most once per mounted surface', async () => {
    const root = await renderProbe({ kind: 'runtime', environmentId: 'env-1' })

    await act(async () => {
      root.render(createElement(HookProbe, { target: { kind: 'runtime', environmentId: 'env-2' } }))
    })
    await flushEffects()
    await act(async () => {
      root.render(createElement(HookProbe, { target: { kind: 'runtime', environmentId: 'env-1' } }))
    })
    await flushEffects()

    expect(
      runtimeEnvironmentCall.mock.calls.filter(
        ([{ method }]) => method === 'preflight.detectAgents'
      )
    ).toHaveLength(2)
  })

  it('does not re-probe after an explicit refresh finds no agents', async () => {
    useAppStore.setState({
      runtimeDetectedAgentIds: { 'env-1': ['claude'] },
      isDetectingRuntimeAgents: { 'env-1': false }
    })
    let detectCalls = 0
    let refreshCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      let result: unknown
      if (method === 'status.get') {
        result = {
          runtimeId: 'remote-runtime',
          rendererGraphEpoch: 1,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
        }
      } else if (method === 'preflight.refreshAgents') {
        refreshCalls += 1
        result = {
          agents: [],
          addedPathSegments: [],
          shellHydrationOk: true,
          pathSource: 'shell_hydrate',
          pathFailureReason: 'none'
        }
      } else {
        detectCalls += 1
        result = ['claude']
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    await renderProbe({ kind: 'runtime', environmentId: 'env-1' })
    await renderProbe({ kind: 'runtime', environmentId: 'env-1' })
    await act(async () => {
      await latestHookResult?.refresh()
    })
    await flushEffects()

    expect(refreshCalls).toBe(1)
    expect(detectCalls).toBe(0)
    expect(useAppStore.getState().runtimeDetectedAgentIds['env-1']).toEqual([])
  })

  it('retries a cached empty runtime result when the launch surface is reopened', async () => {
    let detectCalls = 0
    runtimeEnvironmentCall.mockImplementation(({ method }: { method: string }) => {
      let result: unknown
      if (method === 'status.get') {
        result = {
          runtimeId: 'remote-runtime',
          rendererGraphEpoch: 1,
          graphStatus: 'ready',
          authoritativeWindowId: null,
          liveTabCount: 0,
          liveLeafCount: 0,
          runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
          minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
        }
      } else {
        detectCalls += 1
        result = detectCalls === 1 ? [] : ['kilo']
      }
      return Promise.resolve({
        id: method,
        ok: true,
        result,
        _meta: { runtimeId: 'remote-runtime' }
      })
    })

    const firstRoot = await renderProbe({ kind: 'runtime', environmentId: 'env-1' })

    expect(detectCalls).toBe(1)
    expect(useAppStore.getState().runtimeDetectedAgentIds['env-1']).toEqual([])

    await act(async () => {
      firstRoot.unmount()
    })
    roots.splice(roots.indexOf(firstRoot), 1)

    await renderProbe({ kind: 'runtime', environmentId: 'env-1' })

    expect(detectCalls).toBe(2)
    expect(useAppStore.getState().runtimeDetectedAgentIds['env-1']).toEqual(['kilo'])
  })
})
