// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspacePort, WorkspacePortScanResult } from '../../../shared/workspace-ports'

const { runWorkspacePortScanForTargetMock } = vi.hoisted(() => ({
  runWorkspacePortScanForTargetMock: vi.fn()
}))

vi.mock('./workspace-port-scan-client', () => ({
  runWorkspacePortScanForTarget: runWorkspacePortScanForTargetMock
}))

const {
  mergeWorkspacePortScans,
  refreshWorkspacePortScanAfterStop,
  workspacePortScanKeyForTarget
} = await import('./workspace-port-actions')

function scanWithPort(port: WorkspacePort | null, scannedAt = 1): WorkspacePortScanResult {
  return { platform: 'darwin', scannedAt, ports: port ? [port] : [] }
}

function port(id: string): WorkspacePort {
  return {
    id,
    bindHost: '127.0.0.1',
    connectHost: '127.0.0.1',
    port: 5199,
    processName: 'node',
    protocol: 'http',
    kind: 'external'
  }
}

/** Mirrors the Zustand store's read-after-write semantics the bug depended on. */
function makeScanStoreHarness(): {
  scansByKey: Record<string, WorkspacePortScanResult>
  projections: { key: string; result: WorkspacePortScanResult }[]
  setWorkspacePortScanForKey: (key: string, scan: WorkspacePortScanResult | null) => void
  setWorkspacePortScan: (next: { key: string; result: WorkspacePortScanResult } | null) => void
  getWorkspacePortScansByKey: () => Record<string, WorkspacePortScanResult>
  setWorkspacePortScanRefreshing: (value: boolean) => void
} {
  const scansByKey: Record<string, WorkspacePortScanResult> = {}
  const projections: { key: string; result: WorkspacePortScanResult }[] = []
  return {
    scansByKey,
    projections,
    setWorkspacePortScanForKey: (key, scan) => {
      if (scan) {
        scansByKey[key] = scan
      } else {
        delete scansByKey[key]
      }
    },
    setWorkspacePortScan: (next) => {
      if (next) {
        projections.push(next)
      }
    },
    getWorkspacePortScansByKey: () => scansByKey,
    setWorkspacePortScanRefreshing: () => {}
  }
}

describe('mergeWorkspacePortScans', () => {
  it('returns a single entry verbatim, without prefixing ids', () => {
    const scan = scanWithPort(port('tcp:5199'))
    expect(mergeWorkspacePortScans({ 'local:all': scan })).toBe(scan)
  })

  it('concatenates ports across multiple entries with key-prefixed ids', () => {
    const merged = mergeWorkspacePortScans({
      'local:all': scanWithPort(port('tcp:5199')),
      'environment:x:all': scanWithPort(port('tcp:6000'))
    })
    expect(merged?.ports.map((p) => p.id)).toEqual([
      'environment:x:all:tcp:6000',
      'local:all:tcp:5199'
    ])
  })
})

describe('refreshWorkspacePortScanAfterStop', () => {
  const target = { kind: 'local' as const }
  const scanKey = workspacePortScanKeyForTarget(target)

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    runWorkspacePortScanForTargetMock.mockReset()
  })

  it('publishes the settled scan under the plain host key, not a synthetic aggregate, for a single tracked host', async () => {
    // Regression for the ghost-duplicate-row bug: a single host was wrongly treated as multi-host.
    runWorkspacePortScanForTargetMock
      .mockResolvedValueOnce(scanWithPort(port('tcp:5199'), 1))
      .mockResolvedValueOnce(scanWithPort(null, 2))
    const harness = makeScanStoreHarness()

    const resultPromise = refreshWorkspacePortScanAfterStop({
      runtimeTarget: target,
      setWorkspacePortScan: harness.setWorkspacePortScan,
      setWorkspacePortScanForKey: harness.setWorkspacePortScanForKey,
      setWorkspacePortScanRefreshing: harness.setWorkspacePortScanRefreshing,
      getWorkspacePortScansByKey: harness.getWorkspacePortScansByKey
    })
    await vi.advanceTimersByTimeAsync(500)
    await resultPromise

    expect(harness.projections).toHaveLength(2)
    const settled = harness.projections[1]
    expect(settled.key).toBe(scanKey)
    expect(settled.result.ports).toHaveLength(0)
  })

  it('aggregates under the synthetic key only when a second host is genuinely tracked', async () => {
    runWorkspacePortScanForTargetMock
      .mockResolvedValueOnce(scanWithPort(port('tcp:5199'), 1))
      .mockResolvedValueOnce(scanWithPort(null, 2))
    const harness = makeScanStoreHarness()
    harness.scansByKey['environment:other:all'] = scanWithPort(port('tcp:6000'))

    const resultPromise = refreshWorkspacePortScanAfterStop({
      runtimeTarget: target,
      setWorkspacePortScan: harness.setWorkspacePortScan,
      setWorkspacePortScanForKey: harness.setWorkspacePortScanForKey,
      setWorkspacePortScanRefreshing: harness.setWorkspacePortScanRefreshing,
      getWorkspacePortScansByKey: harness.getWorkspacePortScansByKey
    })
    await vi.advanceTimersByTimeAsync(500)
    await resultPromise

    const settled = harness.projections[1]
    expect(settled.key).toBe('all-hosts:all')
    expect(settled.result.ports.map((p) => p.id)).toEqual(['environment:other:all:tcp:6000'])
  })
})
