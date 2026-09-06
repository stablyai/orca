import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import { mintFleetAgentStatusEvidence } from './orchestration-fleet-agent-status-evidence'
import {
  projectOrchestrationFleet,
  type FleetDurableWorker
} from './orchestration-fleet-projection'
import {
  parseWorkerTerminalHostScope,
  readWorkerTerminalHostScope
} from './worker-terminal-host-scope'

/**
 * One durable column, one classification. The fleet host label and the remote-connection fence
 * used to parse `host_scope` independently, so a WSL-on-local row could read `local` for its
 * host and remote for the connection its evidence had to carry — and the worker projected
 * `unverifiable` while running on this machine.
 */
const PANE_KEY = 'tab-host:leaf-host'
const TERMINAL_HANDLE = 'term_host'
const NOW = 100_000

type HostScopeCase = {
  label: string
  hostScope: string | null
  /** The host label with no connection id on the status row. */
  host: { kind: 'local' | 'remote'; id: string }
  /** A connection id the fence must accept as this worker's evidence. */
  accepts: string | null
  /** A connection id the fence must reject, when the scope names a target at all. */
  rejects?: string
}

const CASES: readonly HostScopeCase[] = [
  {
    label: 'absent scope is legacy local authority',
    hostScope: null,
    host: { kind: 'local', id: 'local' },
    accepts: null
  },
  {
    label: 'local scope',
    hostScope: '{"kind":"local","hostId":"local"}',
    host: { kind: 'local', id: 'local' },
    accepts: null
  },
  {
    label: 'wsl on local',
    hostScope: '{"kind":"wsl","hostId":"local"}',
    host: { kind: 'local', id: 'local' },
    accepts: null
  },
  {
    label: 'wsl on local with a distro',
    hostScope: '{"kind":"wsl","hostId":"local","distro":"Ubuntu"}',
    host: { kind: 'local', id: 'local' },
    accepts: null
  },
  {
    label: 'wsl on local carrying a stray target id',
    hostScope: '{"kind":"wsl","hostId":"local","distro":"Ubuntu","targetId":"host-9"}',
    host: { kind: 'local', id: 'local' },
    accepts: null
  },
  {
    label: 'ssh target',
    hostScope: '{"kind":"ssh","targetId":"host-1"}',
    host: { kind: 'remote', id: 'host-1' },
    accepts: 'host-1',
    rejects: 'someone-else'
  },
  {
    label: 'unknown remote kind',
    hostScope: '{"kind":"podman","hostId":"box"}',
    host: { kind: 'remote', id: 'box' },
    accepts: 'any-connection'
  },
  {
    label: 'malformed scope is not local',
    hostScope: '{not json',
    host: { kind: 'remote', id: 'unknown' },
    accepts: 'any-connection'
  },
  {
    label: 'ssh scope with an empty target id names no host',
    hostScope: '{"kind":"ssh","targetId":""}',
    host: { kind: 'remote', id: 'ssh' },
    accepts: 'any-connection'
  },
  {
    label: 'local scope naming another host id',
    hostScope: '{"kind":"local","hostId":"other"}',
    host: { kind: 'local', id: 'other' },
    accepts: null
  },
  {
    label: 'legacy local prefix',
    hostScope: 'local:workspace-1',
    host: { kind: 'local', id: 'local' },
    accepts: null
  }
]

function worker(hostScope: string | null): FleetDurableWorker {
  return {
    dispatchId: 'disp-host',
    taskId: 'task-host',
    runId: 'run-host',
    parentTaskId: null,
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    workerStage: 'prompt_delivered',
    agentTerminalHandle: TERMINAL_HANDLE,
    paneKey: PANE_KEY,
    worktreeId: 'wt-host',
    terminalState: 'active',
    resource: {
      id: 'res-host',
      ownerDispatchId: 'disp-host',
      worktreeId: 'wt-host',
      paneKey: PANE_KEY,
      hostScope,
      ownershipState: 'owned',
      releaseState: 'not_requested',
      updatedAt: '2026-01-01T00:00:00Z'
    }
  }
}

function evidence(connectionId: string | null) {
  return mintFleetAgentStatusEvidence(
    {
      paneKey: PANE_KEY,
      connectionId,
      state: 'working',
      prompt: '',
      receivedAt: NOW - 1,
      stateStartedAt: NOW - 1
    } as AgentStatusIpcPayload,
    {
      kind: 'pane',
      terminalHandle: TERMINAL_HANDLE,
      paneKey: PANE_KEY,
      processIncarnation: 'pty-host:inc-1'
    }
  )
}

/** `live` proves the status row was accepted as this worker's evidence; the fence is the
 *  only thing that can reject it here, so the verdict reads the fence directly. */
function acceptsConnection(hostScope: string | null, connectionId: string | null): boolean {
  const page = projectOrchestrationFleet({
    workers: [worker(hostScope)],
    statuses: [evidence(connectionId)],
    now: NOW
  })
  return page.workers[0]?.liveness.verdict === 'live'
}

describe('worker terminal host scope', () => {
  for (const testCase of CASES) {
    it(`classifies ${testCase.label} the same way in every consumer`, () => {
      const read = readWorkerTerminalHostScope(testCase.hostScope)

      expect(read.kind === 'local' || read.kind === 'absent' ? 'local' : 'remote').toBe(
        testCase.host.kind
      )

      const page = projectOrchestrationFleet({
        workers: [worker(testCase.hostScope)],
        statuses: [evidence(null)],
        now: NOW
      })
      expect(page.workers[0]?.host).toEqual(testCase.host)

      // The fence and the host label come from one read: a row the projection calls local
      // must not demand a remote connection id, and vice versa.
      expect(acceptsConnection(testCase.hostScope, testCase.accepts)).toBe(true)
      if (testCase.rejects) {
        expect(acceptsConnection(testCase.hostScope, testCase.rejects)).toBe(false)
      }
    })
  }

  it('keeps the strict scope contract the process-liveness path depends on', () => {
    expect(parseWorkerTerminalHostScope('{"kind":"ssh","targetId":"host-1"}')).toEqual({
      kind: 'ssh',
      targetId: 'host-1'
    })
    expect(
      parseWorkerTerminalHostScope('{"kind":"wsl","hostId":"local","distro":"Ubuntu"}')
    ).toEqual({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' })
    expect(parseWorkerTerminalHostScope('{"kind":"local","hostId":"local"}')).toEqual({
      kind: 'local',
      hostId: 'local'
    })
    // A scope missing the facts its kind requires is not a scope.
    expect(parseWorkerTerminalHostScope('{"kind":"wsl","hostId":"local"}')).toBeNull()
    expect(parseWorkerTerminalHostScope('{"kind":"ssh"}')).toBeNull()
    expect(parseWorkerTerminalHostScope('local:workspace-1')).toBeNull()
    expect(parseWorkerTerminalHostScope(null)).toBeNull()
  })
})
