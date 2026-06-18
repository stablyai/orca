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
import { useAppStore } from '@/store'
import { WorkspacePortScanner } from './WorkspacePortScanner'

const localScan = vi.fn()
const runtimeEnvironmentCall = vi.fn()
let container: HTMLDivElement | null = null
let root: Root | null = null

const emptyScan: WorkspacePortScanResult = {
  platform: 'darwin',
  scannedAt: 1,
  ports: []
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

function seedRemoteWorkspace(): void {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      activeRuntimeEnvironmentId: 'env-1'
    },
    repos: [
      {
        id: 'repo-1',
        path: '/remote/repo',
        displayName: 'Remote Repo',
        connectionId: null,
        executionHostId: toRuntimeExecutionHostId('env-1')
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
})
