import { describe, expect, it } from 'vitest'
import type { WorkspacePort } from '../../../../shared/workspace/ports/workspace-ports'
import {
  DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS,
  type RuntimePortForward
} from '../../../../shared/runtime-port-forwards'
import {
  isAgentCliProcessName,
  isAutoForwardCandidate,
  planAutoForwards
} from './runtime-port-auto-forward-plan'

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

  it("never forwards an agent CLI's own listener, at any port or protocol", () => {
    const agentPort = (port: number, processName: string): WorkspacePort => ({
      ...workspace(port),
      processName
    })
    // The toast a real run showed: "Forwarded :34719 to localhost:34719 · codex · sand23".
    const plan = planAutoForwards({
      ...base,
      ports: [
        agentPort(34719, 'codex'),
        agentPort(1455, 'codex'),
        agentPort(5173, '/usr/local/bin/claude'),
        agentPort(4096, 'opencode'),
        agentPort(8080, 'codex-linux-x64'),
        agentPort(3000, 'node')
      ],
      forwards: []
    })
    expect(plan.open.map((port) => port.port)).toEqual([3000])
  })

  it('skips an anonymous ephemeral port, but not one with a known web port or a printed URL', () => {
    const settings = DEFAULT_RUNTIME_PORT_FORWARD_SETTINGS
    const unknown = (port: number): Extract<WorkspacePort, { kind: 'workspace' }> => ({
      id: `127.0.0.1:${port}`,
      kind: 'workspace',
      owner,
      bindHost: '127.0.0.1',
      connectHost: 'localhost',
      port,
      protocol: 'unknown',
      processName: 'node'
    })
    // An agent's MCP child or a language server: high port, no URL, nothing known about it.
    expect(isAutoForwardCandidate(unknown(41234), settings)).toBe(false)
    // The user's dev server on its usual port (protocol not inferred) still forwards.
    expect(isAutoForwardCandidate(unknown(5173), settings)).toBe(true)
    // A dev server on a high port that printed its URL forwards too.
    expect(
      isAutoForwardCandidate(
        { ...unknown(41234), protocol: 'http', advertisedUrl: 'http://localhost:41234' },
        settings
      )
    ).toBe(true)
  })

  it('retires an earlier auto forward of an agent port once it is idle', () => {
    const plan = planAutoForwards({
      ...base,
      previousMissing: new Map([[34719, 1]]),
      ports: [{ ...workspace(34719), processName: 'codex' }],
      forwards: [auto(34719)]
    })
    expect(plan.close.map((forward) => forward.remotePort)).toEqual([34719])
  })
})

describe('isAgentCliProcessName', () => {
  it('names agent CLIs by binary, path, .exe or platform suffix, and nothing else', () => {
    for (const name of [
      'codex',
      'Codex',
      '/opt/bin/claude',
      'C:\\bin\\codex.exe',
      'codex-x86_64'
    ]) {
      expect(isAgentCliProcessName(name)).toBe(true)
    }
    for (const name of [undefined, '', 'node', 'vite', 'next-server', 'claudette', 'python3']) {
      expect(isAgentCliProcessName(name)).toBe(false)
    }
  })
})
