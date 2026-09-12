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
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'

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
  onResult
}: {
  target: AgentDetectionTarget | undefined
  onResult?: (result: UseDetectedAgentsResult) => void
}): null {
  latestHookResult = useDetectedAgents(target)
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

describe('Floating Workspace authority', () => {
  it('advertises native Windows agents beside an active WSL project', async () => {
    const activeResult: { current: UseDetectedAgentsResult | null } = { current: null }
    const floatingResult: { current: UseDetectedAgentsResult | null } = { current: null }
    useAppStore.getState().clearLocalDetectedAgents()
    useAppStore.setState({
      activeRepoId: 'repo-wsl',
      activeWorktreeId: 'worktree-wsl',
      projects: [
        {
          id: 'repo-wsl',
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      ],
      repos: [
        {
          id: 'repo-wsl',
          path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo',
          displayName: 'WSL project',
          badgeColor: '#000000',
          addedAt: 0
        }
      ],
      worktreesByRepo: {
        'repo-wsl': [
          {
            id: 'worktree-wsl',
            repoId: 'repo-wsl',
            path: '\\\\wsl.localhost\\Ubuntu\\home\\alice\\repo',
            displayName: 'main'
          }
        ]
      }
    } as never)

    await renderProbe(
      { kind: 'local', worktreeId: 'worktree-wsl' } as AgentDetectionTarget,
      (result) => {
        activeResult.current = result
      }
    )
    await renderProbe(
      {
        kind: 'local',
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        contextKey: 'host'
      } as AgentDetectionTarget,
      (result) => {
        floatingResult.current = result
      }
    )

    expect(activeResult.current?.detectedIds).toEqual(['claude'])
    expect(floatingResult.current?.detectedIds).toEqual(['codex'])
    expect(useAppStore.getState().detectedAgentIds).toEqual(['claude'])
    const detectedContexts = detectLocalAgents.mock.calls.map(([context]) => context)
    expect(detectedContexts).toEqual([
      expect.objectContaining({
        projectRuntime: expect.objectContaining({
          runtime: expect.objectContaining({ kind: 'wsl', distro: 'Ubuntu' })
        })
      }),
      undefined
    ])

    refreshLocalAgents.mockResolvedValueOnce({
      agents: ['codex'],
      addedPathSegments: [],
      shellHydrationOk: true,
      pathSource: 'process_env',
      pathFailureReason: 'none'
    })
    await act(async () => {
      await floatingResult.current?.refresh()
    })
    await flushEffects()

    expect(activeResult.current?.detectedIds).toEqual(['claude'])
    expect(floatingResult.current?.detectedIds).toEqual(['codex'])
    expect(useAppStore.getState().detectedAgentIds).toEqual(['claude'])
    expect(refreshLocalAgents).toHaveBeenLastCalledWith(undefined)
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
