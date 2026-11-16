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
} from '../../../shared/remote-runtime/protocol/protocol-version'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import '../../../shared/orca-profiles/constants'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const detectLocalAgents = vi.fn()
const detectRemoteAgents = vi.fn()
const refreshLocalAgents = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []
let latestHookResult: UseDetectedAgentsResult | null = null

function HookProbe({
  target,
  onResult,
  inventory
}: {
  target: AgentDetectionTarget | undefined
  onResult?: (result: UseDetectedAgentsResult) => void
  inventory?: 'enabled' | 'all'
}): null {
  latestHookResult = useDetectedAgents(target, inventory)
  onResult?.(latestHookResult)
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderProbe(
  target: AgentDetectionTarget | undefined,
  onResult?: (result: UseDetectedAgentsResult) => void
): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { target, onResult }))
  })
  await flushEffects()
  return root
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  useAppStore.setState(initialAppState, true)
  latestHookResult = null
  detectRemoteAgents.mockReset().mockResolvedValue([])
  detectLocalAgents
    .mockReset()
    .mockImplementation((context) =>
      Promise.resolve(context?.projectRuntime?.runtime.kind === 'wsl' ? ['claude'] : ['codex'])
    )
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
    preflight: {
      detectAgents: detectLocalAgents,
      detectRemoteAgents,
      refreshAgents: refreshLocalAgents
    },
    runtimeEnvironments: { call: runtimeEnvironmentCall },
    platform: { get: () => ({ platform: 'win32' }) }
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
