// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/runtime-rpc-client'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import { useAppStore } from '@/store'
import { WorkspacePortScanner } from './WorkspacePortScanner'

const localScan = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const remoteScanKey = 'environment:env-1:all'
const remoteWorktreeId = 'repo-1::/remote/repo'
let container: HTMLDivElement | null = null
let root: Root | null = null

const emptyScan: WorkspacePortScanResult = {
  platform: 'darwin',
  scannedAt: 1,
  ports: []
}
const liveScan: WorkspacePortScanResult = {
  platform: 'linux',
  scannedAt: 1,
  ports: [
    {
      id: 'tcp:3000',
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: 3000,
      protocol: 'http',
      kind: 'workspace',
      owner: {
        worktreeId: remoteWorktreeId,
        repoId: 'repo-1',
        displayName: 'main',
        path: '/remote/repo',
        confidence: 'cwd'
      }
    }
  ]
}

function addRemoteWorkspace(environmentId: string): void {
  const state = useAppStore.getState()
  const repoId = `repo-${environmentId}`
  const path = `/remote/${environmentId}`
  useAppStore.setState({
    repos: [
      ...state.repos,
      {
        id: repoId,
        path,
        displayName: environmentId,
        connectionId: null,
        executionHostId: toRuntimeExecutionHostId(environmentId)
      }
    ] as never,
    worktreesByRepo: {
      ...state.worktreesByRepo,
      [repoId]: [
        {
          id: `${repoId}::${path}`,
          repoId,
          path,
          displayName: 'main'
        }
      ]
    } as never
  })
}

function removeRemoteWorkspaces(environmentIds: string[]): void {
  const repoIds = new Set(environmentIds.map((environmentId) => `repo-${environmentId}`))
  const state = useAppStore.getState()
  useAppStore.setState({
    repos: state.repos.filter((repo) => !repoIds.has(repo.id)) as never,
    worktreesByRepo: Object.fromEntries(
      Object.entries(state.worktreesByRepo).filter(([repoId]) => !repoIds.has(repoId))
    ) as never
  })
}

function removeAllWorktrees(): void {
  const state = useAppStore.getState()
  useAppStore.setState({
    worktreesByRepo: Object.fromEntries(
      Object.keys(state.worktreesByRepo).map((repoId) => [repoId, []])
    ) as never
  })
}

function overrideDocumentVisibilityState(
  getVisibilityState: () => DocumentVisibilityState
): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'visibilityState')
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: getVisibilityState
  })
  return () => {
    if (descriptor) {
      Object.defineProperty(document, 'visibilityState', descriptor)
    } else {
      Reflect.deleteProperty(document, 'visibilityState')
    }
  }
}

function getPublishedRemoteWorktreePorts() {
  return getWorkspacePortsByWorktreeId(useAppStore.getState().workspacePortScan?.result).get(
    remoteWorktreeId
  )
}

const compatibleStatus = {
  runtimeId: 'env-1',
  graphStatus: 'ready',
  runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
  minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function seedRemoteWorkspace(environmentId = 'env-1'): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      activeRuntimeEnvironmentId: environmentId
    },
    repos: [
      {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'Remote Repo',
        connectionId: null,
        executionHostId: toRuntimeExecutionHostId(environmentId)
      }
    ] as never,
    worktreesByRepo: {
      'repo-1': [
        {
          id: 'repo-1::/remote/repo',
          repoId: 'repo-1',
          path: '/remote/repo',
          displayName: 'main'
        }
      ]
    } as never,
    workspacePortScan: null,
    workspacePortScansByKey: {},
    workspacePortScanRefreshing: false
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(0)
  localScan.mockReset()
  runtimeEnvironmentCall.mockReset()
  localScan.mockResolvedValue(emptyScan)
  runtimeEnvironmentCall.mockImplementation(({ method }) => {
    if (method === 'status.get') {
      return Promise.resolve({ ok: true, result: compatibleStatus })
    }
    if (method === 'workspacePorts.scan') {
      return Promise.resolve({ ok: true, result: emptyScan })
    }
    return Promise.resolve({ ok: false, error: { code: 'method_not_found', message: method } })
  })
  vi.stubGlobal('window', {
    ...window,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    api: {
      workspacePorts: {
        scan: localScan,
        onAdvertisedUrlChanged: vi.fn(() => vi.fn())
      },
      runtimeEnvironments: {
        call: runtimeEnvironmentCall
      }
    }
  })
  clearRuntimeCompatibilityCache()
  markRuntimeEnvironmentCompatible('env-1')
  seedRemoteWorkspace()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  if (root) {
    act(() => root?.unmount())
  }
  root = null
  container?.remove()
  container = null
  vi.useRealTimers()
  vi.unstubAllGlobals()
  clearRuntimeCompatibilityCache()
})

describe('WorkspacePortScanner', () => {
  it('does not restart remote scans before the background interval when host inputs rerender', async () => {
    await act(async () => {
      root?.render(<WorkspacePortScanner />)
      await flushPromises()
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-1',
      method: 'workspacePorts.scan',
      params: {},
      timeoutMs: 15_000
    })
    const firstPublishedScan = useAppStore.getState().workspacePortScan
    expect(firstPublishedScan).not.toBeNull()

    await act(async () => {
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/tmp/orca-workspaces'),
          activeRuntimeEnvironmentId: 'env-1'
        }
      })
      await flushPromises()
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().workspacePortScan).toBe(firstPublishedScan)

    await act(async () => {
      vi.advanceTimersByTime(29_999)
      await flushPromises()
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)

    await act(async () => {
      vi.advanceTimersByTime(1)
      await flushPromises()
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
  })

  it('scans a changed execution host immediately instead of applying the prior throttle', async () => {
    await act(async () => {
      root?.render(<WorkspacePortScanner />)
      await flushPromises()
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)

    markRuntimeEnvironmentCompatible('env-2')
    await act(async () => {
      seedRemoteWorkspace('env-2')
      await flushPromises()
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-2',
      method: 'workspacePorts.scan',
      params: {},
      timeoutMs: 15_000
    })
  })

  it('keeps an unchanged host scan when another execution host is added', async () => {
    let env1Attempts = 0
    runtimeEnvironmentCall.mockImplementation(({ selector, method }) => {
      if (method !== 'workspacePorts.scan') {
        return Promise.resolve({ ok: false, error: { code: 'method_not_found', message: method } })
      }
      if (selector !== 'env-1') {
        return Promise.resolve({ ok: true, result: emptyScan })
      }
      env1Attempts += 1
      return Promise.resolve({ ok: true, result: liveScan })
    })

    await act(async () => {
      root?.render(<WorkspacePortScanner />)
      await flushPromises()
    })
    expect(useAppStore.getState().workspacePortScansByKey[remoteScanKey]).toBe(liveScan)

    markRuntimeEnvironmentCompatible('env-2')
    await act(async () => {
      addRemoteWorkspace('env-2')
      await flushPromises()
    })

    expect(env1Attempts).toBe(1)
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
      selector: 'env-2',
      method: 'workspacePorts.scan',
      params: {},
      timeoutMs: 15_000
    })
    expect(getPublishedRemoteWorktreePorts()).toHaveLength(1)
  })

  it('scans only the added host when the window becomes visible', async () => {
    let env1Attempts = 0
    runtimeEnvironmentCall.mockImplementation(({ selector, method }) => {
      if (method !== 'workspacePorts.scan') {
        return Promise.resolve({ ok: false, error: { code: 'method_not_found', message: method } })
      }
      if (selector !== 'env-1') {
        return Promise.resolve({ ok: true, result: emptyScan })
      }
      env1Attempts += 1
      return Promise.resolve({ ok: true, result: liveScan })
    })
    let visibilityState: DocumentVisibilityState = 'visible'
    const restoreVisibilityState = overrideDocumentVisibilityState(() => visibilityState)
    try {
      await act(async () => {
        root?.render(<WorkspacePortScanner />)
        await flushPromises()
      })
      expect(env1Attempts).toBe(1)

      visibilityState = 'hidden'
      markRuntimeEnvironmentCompatible('env-2')
      await act(async () => {
        addRemoteWorkspace('env-2')
        await flushPromises()
      })
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)

      visibilityState = 'visible'
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'))
        await flushPromises()
      })

      expect(env1Attempts).toBe(1)
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
      expect(runtimeEnvironmentCall).toHaveBeenLastCalledWith({
        selector: 'env-2',
        method: 'workspacePorts.scan',
        params: {},
        timeoutMs: 15_000
      })
    } finally {
      restoreVisibilityState()
    }
  })

  it('clears the refreshing state when a retained-host focus change supersedes a poll', async () => {
    let env1Calls = 0
    let env2Calls = 0
    let resolveSecondPoll!: (result: { ok: true; result: WorkspacePortScanResult }) => void
    const secondPoll = new Promise<{ ok: true; result: WorkspacePortScanResult }>((resolve) => {
      resolveSecondPoll = resolve
    })
    runtimeEnvironmentCall.mockImplementation(({ selector, method }) => {
      if (method !== 'workspacePorts.scan') {
        return Promise.resolve({ ok: false, error: { code: 'method_not_found', message: method } })
      }
      if (selector === 'env-1') {
        env1Calls += 1
        return env1Calls === 1 ? Promise.resolve({ ok: true, result: liveScan }) : secondPoll
      }
      env2Calls += 1
      return env2Calls === 1 ? Promise.resolve({ ok: true, result: emptyScan }) : secondPoll
    })
    markRuntimeEnvironmentCompatible('env-2')
    addRemoteWorkspace('env-2')

    await act(async () => {
      root?.render(<WorkspacePortScanner />)
      await flushPromises()
    })

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await flushPromises()
    })
    expect(useAppStore.getState().workspacePortScanRefreshing).toBe(true)

    await act(async () => {
      useAppStore.setState({
        settings: {
          ...getDefaultSettings('/tmp/orca-workspaces'),
          activeRuntimeEnvironmentId: 'env-2'
        }
      })
      await flushPromises()
    })
    expect(useAppStore.getState().workspacePortScanRefreshing).toBe(false)

    await act(async () => {
      resolveSecondPoll({ ok: true, result: emptyScan })
      await flushPromises()
    })
  })

  it('removes multiple stale host scans in one map publication', async () => {
    markRuntimeEnvironmentCompatible('env-2')
    markRuntimeEnvironmentCompatible('env-3')
    addRemoteWorkspace('env-2')
    addRemoteWorkspace('env-3')

    await act(async () => {
      root?.render(<WorkspacePortScanner />)
      await flushPromises()
    })

    let mapNotifications = 0
    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      if (state.workspacePortScansByKey !== previousState.workspacePortScansByKey) {
        mapNotifications += 1
      }
    })
    await act(async () => {
      removeRemoteWorkspaces(['env-2', 'env-3'])
      await flushPromises()
    })
    unsubscribe()

    expect(mapNotifications).toBe(1)
    expect(useAppStore.getState().workspacePortScansByKey['environment:env-2:all']).toBeUndefined()
    expect(useAppStore.getState().workspacePortScansByKey['environment:env-3:all']).toBeUndefined()
  })

  it('clears ports immediately when the final worktree is removed', async () => {
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method === 'workspacePorts.scan') {
        return Promise.resolve({ ok: true, result: liveScan })
      }
      return Promise.resolve({ ok: false, error: { code: 'method_not_found', message: method } })
    })

    await act(async () => {
      root?.render(<WorkspacePortScanner />)
      await flushPromises()
    })
    expect(useAppStore.getState().workspacePortScan).not.toBeNull()

    await act(async () => {
      removeAllWorktrees()
      await flushPromises()
    })

    expect(useAppStore.getState().workspacePortScan).toBeNull()
    expect(useAppStore.getState().workspacePortScansByKey).toEqual({})
    expect(useAppStore.getState().workspacePortScanRefreshing).toBe(false)
  })

  it('keeps the last reachable ports through one failed remote poll', async () => {
    let scanAttempts = 0
    runtimeEnvironmentCall.mockImplementation(({ method }) => {
      if (method !== 'workspacePorts.scan') {
        return Promise.resolve({ ok: false, error: { code: 'method_not_found', message: method } })
      }
      scanAttempts += 1
      if (scanAttempts === 1) {
        return Promise.resolve({ ok: true, result: liveScan })
      }
      return Promise.reject(new Error('temporary runtime failure'))
    })

    await act(async () => {
      root?.render(<WorkspacePortScanner />)
      await flushPromises()
    })
    expect(useAppStore.getState().workspacePortScansByKey[remoteScanKey]).toBe(liveScan)
    expect(getPublishedRemoteWorktreePorts()).toHaveLength(1)

    let mapNotifications = 0
    let projectionNotifications = 0
    const firstProjection = useAppStore.getState().workspacePortScan
    const unsubscribe = useAppStore.subscribe((state, previousState) => {
      if (state.workspacePortScansByKey !== previousState.workspacePortScansByKey) {
        mapNotifications += 1
      }
      if (state.workspacePortScan !== previousState.workspacePortScan) {
        projectionNotifications += 1
      }
    })

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await flushPromises()
    })
    unsubscribe()
    expect(useAppStore.getState().workspacePortScansByKey[remoteScanKey]).toBe(liveScan)
    expect(getPublishedRemoteWorktreePorts()).toHaveLength(1)
    expect(mapNotifications).toBe(0)
    expect(useAppStore.getState().workspacePortScan).toBe(firstProjection)
    expect(projectionNotifications).toBe(0)

    await act(async () => {
      vi.advanceTimersByTime(30_000)
      await flushPromises()
    })
    expect(useAppStore.getState().workspacePortScansByKey[remoteScanKey]).toMatchObject({
      ports: [],
      unavailableReason: 'temporary runtime failure'
    })
    expect(getPublishedRemoteWorktreePorts()).toBeUndefined()
  })
})
