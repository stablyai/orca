// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useDetectedAgents, type UseDetectedAgentsResult } from './useDetectedAgents'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_VERSION
} from '../../../shared/protocol-version'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { makeRepo, makeWorktree } from '../components/worktree-jump-palette-test-fixtures'
import {
  getActiveWorkspaceOwnerTarget,
  getResolvedWorktreeExecutionOwner
} from '@/lib/resolved-worktree-execution-host'
import { getWorkspaceFileRevealOwner } from '@/lib/reveal-in-file-manager'
import { getLocalPreflightContext } from '@/lib/local-preflight-context'
import { getEnvironmentRuntimeContextKey } from '@/lib/provider-runtime-context'
import { selectNativeChatWslProject } from '../components/terminal-pane/terminal-pane-host-state'
import {
  getAgentDetectionTargetKeyForWorktree,
  parseAgentDetectionTargetKey,
  useAgentDetectionTargetForWorktree
} from './useAgentDetectionTarget'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const runtimeEnvironmentCall = vi.fn()
const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []
let latest: UseDetectedAgentsResult | null = null

function HookProbe({ worktreeId }: { worktreeId?: string }): null {
  const target = useAgentDetectionTargetForWorktree(worktreeId ?? null)
  latest = useDetectedAgents(worktreeId ? target : { kind: 'runtime', environmentId: 'env-1' })
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderProbe(worktreeId?: string): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, { worktreeId }))
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
  capabilities: [PREFLIGHT_WORKSPACE_SCOPED_RUNTIME_CAPABILITY],
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
  it('wakes a proven runtime alias into addressed inventory while preserving its physical SSH owner', async () => {
    mockHost((_call, method) => Promise.resolve(reply(method, ['codex'])))
    useAppStore.getState().setRuntimeEnvironments([{ ...environment(1), id: 'hub' }])
    const workspace = makeWorktree('repo::/work', 'Work', { repoId: 'repo', hostId: 'ssh:private' })
    useAppStore.setState({
      activeWorktreeId: workspace.id,
      activeWorkspaceExecutionHostId: 'runtime:hub',
      settings: createGlobalSettingsFixture({
        ...useAppStore.getState().settings,
        activeRuntimeEnvironmentId: 'elsewhere'
      }),
      repos: [{ ...makeRepo(), id: 'repo', executionHostId: 'runtime:hub' }],
      worktreesByRepo: { repo: [workspace] }
    })
    await renderProbe(workspace.id)
    expect(getResolvedWorktreeExecutionOwner(useAppStore.getState(), workspace.id)).toBeNull()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    const aliased = { ...workspace, runtimeOwnerEnvironmentId: 'hub' }
    await act(async () => useAppStore.setState({ worktreesByRepo: { repo: [aliased] } }))
    await flushEffects()
    const state = useAppStore.getState()
    expect(getResolvedWorktreeExecutionOwner(state, workspace.id)).toEqual({
      hostId: 'ssh:private',
      workspace: aliased
    })
    expect(getResolvedWorktreeExecutionOwner(state, workspace.id)?.workspace).toBe(aliased)
    const key = getAgentDetectionTargetKeyForWorktree(state, workspace.id)
    expect(key).toBe(`runtime:hub:${encodeURIComponent(workspace.id)}`)
    expect(parseAgentDetectionTargetKey(key)).toEqual({
      kind: 'runtime',
      environmentId: 'hub',
      worktreeId: workspace.id
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'hub',
        method: 'preflight.detectAgents',
        params: { worktreeId: workspace.id }
      })
    )
    expect(latest?.detectedIds).toEqual(['codex'])
    expect(window.api.preflight.detectAgents).not.toHaveBeenCalled()
    expect(window.api.preflight.detectRemoteAgents).not.toHaveBeenCalled()
    expect(selectNativeChatWslProject(state, workspace.id)).toBe(false)
    expect(getWorkspaceFileRevealOwner(state, workspace.id, {})).toBe('ssh:private')
    expect(getActiveWorkspaceOwnerTarget(state)).toEqual({
      kind: 'environment',
      environmentId: 'hub'
    })
    expect(getLocalPreflightContext(state)).toEqual({
      runtimeContextKey: getEnvironmentRuntimeContextKey('hub')
    })

    const calls = runtimeEnvironmentCall.mock.calls.length
    await act(async () => useAppStore.setState({ activeWorkspaceExecutionHostId: 'runtime:rival' }))
    expect(
      getAgentDetectionTargetKeyForWorktree(useAppStore.getState(), workspace.id)
    ).toBeUndefined()
    await act(async () =>
      useAppStore.setState({
        activeWorkspaceExecutionHostId: 'runtime:hub',
        worktreesByRepo: { repo: [aliased, { ...aliased, hostId: 'ssh:other' }] }
      })
    )
    expect(getResolvedWorktreeExecutionOwner(useAppStore.getState(), workspace.id)).toBeNull()
    expect(
      getAgentDetectionTargetKeyForWorktree(useAppStore.getState(), workspace.id)
    ).toBeUndefined()
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(calls)
  })

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
