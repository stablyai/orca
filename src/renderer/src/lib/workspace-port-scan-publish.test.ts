// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  assertRuntimeEnvironmentCapability: vi.fn()
}))
vi.mock('@/runtime/runtime-rpc-result', () => ({
  RuntimeRpcCallError: class RuntimeRpcCallError extends Error {
    code?: string
  }
}))

vi.mock('./workspace-port-scan-client', () => ({
  runWorkspacePortScanForTarget: vi.fn()
}))

const { publishWorkspacePortScanForHost, WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY } =
  await import('./workspace-port-actions')
type WorkspacePortScanPublisher = Parameters<typeof publishWorkspacePortScanForHost>[0]

function scanWithPort(port: number, scannedAt: number): WorkspacePortScanResult {
  return {
    platform: 'linux',
    scannedAt,
    ports: [
      {
        id: `tcp:${port}`,
        bindHost: '0.0.0.0',
        connectHost: '127.0.0.1',
        port,
        pid: 100 + port,
        processName: 'node',
        protocol: 'http',
        kind: 'external'
      }
    ]
  }
}

/** Mirrors the store's replaceWorkspacePortScans semantics: one atomic update. */
function makeStoreHarness(initial: Record<string, WorkspacePortScanResult> = {}): {
  scansByKey: Record<string, WorkspacePortScanResult>
  projections: { key: string; result: WorkspacePortScanResult }[]
  publisher: Omit<WorkspacePortScanPublisher, 'scanKey' | 'scan'>
} {
  let scansByKey: Record<string, WorkspacePortScanResult> = { ...initial }
  const projections: { key: string; result: WorkspacePortScanResult }[] = []
  return {
    get scansByKey() {
      return scansByKey
    },
    projections,
    publisher: {
      replaceWorkspacePortScans: (
        nextScansByKey: Record<string, WorkspacePortScanResult>,
        projection: { key: string; result: WorkspacePortScanResult } | null
      ) => {
        scansByKey = nextScansByKey
        if (projection) {
          projections.push(projection)
        }
      },
      getWorkspacePortScansByKey: () => scansByKey
    }
  }
}

describe('publishWorkspacePortScanForHost', () => {
  let localScan: WorkspacePortScanResult
  let remoteScan: WorkspacePortScanResult

  beforeEach(() => {
    localScan = scanWithPort(5173, 10)
    remoteScan = scanWithPort(3000, 20)
  })

  it('keeps the other host in the projection when one host refreshes', () => {
    const harness = makeStoreHarness({ 'local:all': localScan })

    publishWorkspacePortScanForHost({
      ...harness.publisher,
      scanKey: 'environment:env-1:all',
      scan: remoteScan
    })

    const projection = harness.projections.at(-1)
    expect(projection?.key).toBe(WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY)
    expect(projection?.result.ports.map((port) => port.port).sort()).toEqual([3000, 5173])
    expect(Object.keys(harness.scansByKey).sort()).toEqual(['environment:env-1:all', 'local:all'])
  })

  it('publishes map and projection in a single store update', () => {
    const harness = makeStoreHarness({ 'local:all': localScan })
    const replaceSpy = vi.spyOn(harness.publisher, 'replaceWorkspacePortScans')

    publishWorkspacePortScanForHost({
      ...harness.publisher,
      scanKey: 'environment:env-1:all',
      scan: remoteScan
    })

    // Atomic replacement must notify once and keep map/projection coherent.
    expect(replaceSpy).toHaveBeenCalledTimes(1)
    const [nextScans, projection] = replaceSpy.mock.calls[0]
    expect(Object.keys(nextScans).sort()).toEqual(['environment:env-1:all', 'local:all'])
    expect(projection?.key).toBe(WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY)
  })

  it('does not accumulate duplicate rows across repeated publishes', () => {
    const harness = makeStoreHarness({ 'local:all': localScan })

    publishWorkspacePortScanForHost({
      ...harness.publisher,
      scanKey: 'environment:env-1:all',
      scan: remoteScan
    })
    publishWorkspacePortScanForHost({
      ...harness.publisher,
      scanKey: 'environment:env-1:all',
      scan: { ...remoteScan, scannedAt: 30 }
    })

    // Never store aggregate in per-host state or the next merge multiplies its own rows.
    expect(harness.scansByKey[WORKSPACE_PORT_ALL_HOSTS_SCAN_KEY]).toBeUndefined()
    expect(
      harness.projections
        .at(-1)
        ?.result.ports.map((port) => port.port)
        .sort()
    ).toEqual([3000, 5173])
  })
})
