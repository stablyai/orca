import { describe, it, expect } from 'vitest'
import {
  reconcileTransientPortScanFailures,
  type KeyedPortScan,
  type PortScanDebounceState
} from './workspace-port-scan-debounce'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

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
  it('prunes state for hosts that disappear', () => {
    const { apply, state } = createHarness()
    apply([{ key: 'gone:all', result: good(['tcp:3000']) }])
    apply([{ key: 'other:all', result: good(['tcp:4000']) }])
    expect(state.has('gone:all')).toBe(false)
    expect(state.has('other:all')).toBe(true)
  })
})
