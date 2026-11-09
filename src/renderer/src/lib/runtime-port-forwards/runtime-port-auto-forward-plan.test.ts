import { describe, expect, it } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace-ports'
import {
  DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS,
  type RuntimePortForward
} from '../../../../shared/runtime-port-forwards'
import { planAutoForwards } from './runtime-port-auto-forward-plan'

const owner = {
  worktreeId: 'w',
  repoId: 'r',
  displayName: 'w',
  path: '/w',
  confidence: 'cwd' as const
}
const workspace = (port: number, bindHost = '127.0.0.1'): WorkspacePort => ({
  id: `${bindHost}:${port}`,
  kind: 'workspace',
  owner,
  bindHost,
  connectHost: 'localhost',
  port,
  protocol: 'http'
})
const external = (port: number): WorkspacePort => ({
  id: `x:${port}`,
  kind: 'external',
  bindHost: '127.0.0.1',
  connectHost: 'localhost',
  port,
  protocol: 'http'
})
const auto = (remotePort: number): RuntimePortForward => ({
  id: `f${remotePort}`,
  environmentId: 'e',
  remotePort,
  localPort: remotePort,
  reason: 'auto',
  createdAt: 0,
  openConnections: 0,
  totalConnections: 0,
  bytesToHost: 0,
  bytesFromHost: 0
})
const base = {
  settings: DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS,
  attempted: new Set<number>(),
  previousMissing: new Map<number, number>()
}

describe('planAutoForwards', () => {
  it('forwards workspace servers once per port, skipping Orca ports, other processes and the range', () => {
    const plan = planAutoForwards({
      ...base,
      settings: { ...DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS, rangeEnd: 9000 },
      ports: [
        workspace(5173),
        workspace(5173, '::1'),
        workspace(2222),
        external(3000),
        workspace(9229)
      ],
      forwards: []
    })
    expect(plan.open.map((port) => port.port)).toEqual([5173])
  })

  it('does not retry attempted ports or open anything when auto-forward is off', () => {
    expect(
      planAutoForwards({
        ...base,
        attempted: new Set([5173]),
        ports: [workspace(5173)],
        forwards: []
      }).open
    ).toEqual([])
    expect(
      planAutoForwards({
        ...base,
        settings: { ...DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS, autoForward: false },
        ports: [workspace(5173)],
        forwards: []
      }).open
    ).toEqual([])
  })

  it('retires an auto forward only after it is missing from two scans in a row', () => {
    const first = planAutoForwards({ ...base, ports: [external(5173)], forwards: [auto(5173)] })
    expect(first.close).toEqual([])
    const second = planAutoForwards({
      ...base,
      ports: [],
      forwards: [auto(5173)],
      previousMissing: first.missing
    })
    expect(second.close.map((forward) => forward.remotePort)).toEqual([5173])
  })
})
