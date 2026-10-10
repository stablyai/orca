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

/** Answers status.get; hands each detect call to `detect` with its 1-based index. */
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

describe('useDetectedAgents after a re-pair (mounted runtime surface)', () => {
  it('probes the replacement pairing when the re-pair lands during the first load', async () => {
    let answerOldPairing!: (agents: string[]) => void
    const detectCalls = mockHost((call, method) =>
      call === 1
        ? new Promise((resolve) => {
            answerOldPairing = (agents) => resolve(reply(method, agents))
          })
        : Promise.resolve(reply(method, ['codex']))
    )
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    await renderProbe()
    expect(detectCalls()).toBe(1)
    expect(latest?.isLoading).toBe(true)

    await act(async () => {
      useAppStore.getState().setRuntimeEnvironments([environment(2)])
    })
    await flushEffects()
    answerOldPairing(['claude'])
    await flushEffects()
    await flushEffects()

    expect(detectCalls()).toBe(2)
    expect(latest?.detectedIds).toEqual(['codex'])
    expect(latest?.detectionFailed).toBe(false)
  })

  it('probes the replacement pairing when the old pairing had already failed', async () => {
    const detectCalls = mockHost((call, method) =>
      call === 1
        ? Promise.reject(new Error('runtime disconnected'))
        : Promise.resolve(reply(method, ['codex']))
    )
    useAppStore.getState().setRuntimeEnvironments([environment(1)])
    await renderProbe()
    await flushEffects()
    expect(latest?.detectionFailed).toBe(true)

    await act(async () => {
      useAppStore.getState().setRuntimeEnvironments([environment(2)])
    })
    await flushEffects()
    await flushEffects()

    expect(detectCalls()).toBe(2)
    expect(latest?.detectedIds).toEqual(['codex'])
    expect(latest?.detectionFailed).toBe(false)
  })
})
