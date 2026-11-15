// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/remote-runtime/protocol/protocol-version'
import type { WorkspacePortScanResult } from '../../../../shared/workspace/ports/workspace-ports'
import {
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible
} from '@/runtime/rpc/compatibility/runtime-compatibility-cache'

import { useAppStore } from '@/store'
import { WorkspacePortScanner } from './WorkspacePortScanner'

const localScan = vi.fn()
const runtimeEnvironmentCall = vi.fn()

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

function removeAllWorktrees(): void {
  const state = useAppStore.getState()
  useAppStore.setState({
    worktreesByRepo: Object.fromEntries(
      Object.keys(state.worktreesByRepo).map((repoId) => [repoId, []])
    ) as never
  })
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
})
