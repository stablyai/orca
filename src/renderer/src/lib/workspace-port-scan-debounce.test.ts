import { describe, it, expect } from 'vitest'
import {
  reconcileTransientPortScanFailures,
  type KeyedPortScan,
  type PortScanDebounceState
} from './workspace-port-scan-debounce'
import type { WorkspacePortScanResult } from '../../../shared/workspace-ports'

function good(portIds: string[]): WorkspacePortScanResult {
  return {
    platform: 'unknown',
    scannedAt: 1,
    ports: portIds.map((id) => ({
      id,
      bindHost: '127.0.0.1',
      connectHost: '127.0.0.1',
      port: Number(id.split(':')[1] ?? 0),
      protocol: 'http',
      kind: 'external'
    }))
  }
}

function unavailable(): WorkspacePortScanResult {
  return { platform: 'unknown', scannedAt: 1, ports: [], unavailableReason: 'scan failed' }
}

const FAILURE_THRESHOLD = 2

function createHarness(): {
  apply: (results: KeyedPortScan[]) => KeyedPortScan[]
  publish: (key: string, result: WorkspacePortScanResult) => void
  state: PortScanDebounceState
} {
  const state: PortScanDebounceState = new Map()
  let publishedScans: Record<string, WorkspacePortScanResult> = {}
  return {
    apply: (results) => {
      const reconciled = reconcileTransientPortScanFailures(
        results,
        publishedScans,
        state,
        FAILURE_THRESHOLD
      )
      publishedScans = Object.fromEntries(reconciled.map(({ key, result }) => [key, result]))
      return reconciled
    },
    publish: (key, result) => {
      publishedScans = { ...publishedScans, [key]: result }
    },
    state
  }
}

describe('reconcileTransientPortScanFailures', () => {
  it('keeps the live indicator solid through a single transient failure', () => {
    const { apply } = createHarness()

    const first = apply([{ key: 'host:all', result: good(['tcp:3000']) }])
    expect(first[0].result.ports).toHaveLength(1)

    const second = apply([{ key: 'host:all', result: unavailable() }])
    expect(second[0].result.ports).toHaveLength(1)
    expect(second[0].result.unavailableReason).toBeUndefined()
  })

  it('drops ports only after failures reach the tolerance', () => {
    const { apply } = createHarness()
    apply([{ key: 'h:all', result: good(['tcp:3000']) }])
    apply([{ key: 'h:all', result: unavailable() }])

    const third = apply([{ key: 'h:all', result: unavailable() }])
    expect(third[0].result.ports).toHaveLength(0)
    expect(third[0].result.unavailableReason).toBe('scan failed')
  })

  it('clears immediately when a reachable host reports zero ports', () => {
    const { apply } = createHarness()
    apply([{ key: 'h:all', result: good(['tcp:3000']) }])

    const next = apply([{ key: 'h:all', result: good([]) }])
    expect(next[0].result.ports).toHaveLength(0)
    expect(next[0].result.unavailableReason).toBeUndefined()
  })

  it('resets the failure streak after a successful scan', () => {
    const { apply } = createHarness()
    apply([{ key: 'h:all', result: good(['tcp:3000']) }])
    apply([{ key: 'h:all', result: unavailable() }])
    apply([{ key: 'h:all', result: good(['tcp:3000']) }])

    const afterRecovery = apply([{ key: 'h:all', result: unavailable() }])
    expect(afterRecovery[0].result.ports).toHaveLength(1)
  })

  it('isolates failures per host so a stable host stays solid', () => {
    const { apply } = createHarness()
    apply([
      { key: 'local:all', result: good(['tcp:3000']) },
      { key: 'remote:all', result: good(['tcp:8080']) }
    ])

    const next = apply([
      { key: 'local:all', result: good(['tcp:3000']) },
      { key: 'remote:all', result: unavailable() }
    ])
    expect(next.find((r) => r.key === 'local:all')?.result.ports).toHaveLength(1)
    expect(next.find((r) => r.key === 'remote:all')?.result.ports).toHaveLength(1)
  })

  it('prunes state for hosts that disappear', () => {
    const { apply, state } = createHarness()
    apply([{ key: 'gone:all', result: good(['tcp:3000']) }])
    apply([{ key: 'other:all', result: good(['tcp:4000']) }])
    expect(state.has('gone:all')).toBe(false)
    expect(state.has('other:all')).toBe(true)
  })

  it('prunes the failure counter for a failed-only host that disappears', () => {
    const { apply, state } = createHarness()
    apply([{ key: 'flaky:all', result: unavailable() }])
    expect(state.has('flaky:all')).toBe(true)

    apply([{ key: 'other:all', result: good(['tcp:4000']) }])
    expect(state.has('flaky:all')).toBe(false)
  })

  it('uses a newer manual result instead of resurrecting stale ports', () => {
    const { apply, publish } = createHarness()
    apply([{ key: 'h:all', result: good(['tcp:3000']) }])
    publish('h:all', good([]))

    const next = apply([{ key: 'h:all', result: unavailable() }])

    expect(next[0].result.ports).toHaveLength(0)
    expect(next[0].result.unavailableReason).toBeUndefined()
  })

  it('starts a fresh failure streak after a newer manual result', () => {
    const { apply, publish } = createHarness()
    apply([{ key: 'h:all', result: good(['tcp:3000']) }])
    apply([{ key: 'h:all', result: unavailable() }])
    const manualResult = good([])
    publish('h:all', manualResult)

    const next = apply([{ key: 'h:all', result: unavailable() }])

    expect(next[0].result).toBe(manualResult)
  })
})
