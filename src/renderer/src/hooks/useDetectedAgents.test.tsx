// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDetectedAgents, type AgentDetectionTarget } from './useDetectedAgents'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'

const detectRemoteAgents = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

function HookProbe({ target }: { target: AgentDetectionTarget }): null {
  useDetectedAgents(target)
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderProbe(target: AgentDetectionTarget): Promise<Root> {
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
  useAppStore.setState(initialAppState, true)
  detectRemoteAgents.mockReset().mockResolvedValue([])
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
    preflight: { detectRemoteAgents },
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

describe('useDetectedAgents (runtime call site)', () => {
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
