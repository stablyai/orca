import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from './agent-status-ipc-payload'
import { mintFleetAgentStatusEvidence } from './orchestration-fleet-agent-status-evidence'
import {
  ORCHESTRATION_FLEET_PAGE_MAX,
  projectOrchestrationFleet,
  refreshOrchestrationFleetLivenessAttention,
  type FleetDurableWorker
} from './orchestration-fleet-projection'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'

function worker(id: string, overrides: Partial<FleetDurableWorker> = {}): FleetDurableWorker {
  return {
    dispatchId: id,
    taskId: `task-${id}`,
    runId: 'run-1',
    parentTaskId: null,
    workerState: 'ready',
    dispatchStatus: 'dispatched',
    workerStage: 'prompt_delivered',
    agentTerminalHandle: `term-${id}`,
    paneKey: `tab-${id}:leaf-${id}`,
    worktreeId: `workspace-${id}`,
    terminalState: 'active',
    resource: null,
    ...overrides
  }
}

/** The identity the runtime resolves for the pane. Hand-built here because these cases are
 *  about the projection, not about identity resolution — `fleet-status-terminal-identity` and
 *  the producer census drive the real minter against a real runtime. */
function status(
  id: string,
  receivedAt: number,
  overrides: Partial<AgentStatusIpcPayload> = {},
  processIncarnation = `pty-${id}:inc-1`
) {
  const payload = {
    paneKey: `tab-${id}:leaf-${id}`,
    terminalHandle: `term-${id}`,
    worktreeId: `workspace-${id}`,
    connectionId: null,
    state: 'working',
    prompt: 'secret transcript body',
    agentType: 'codex',
    model: 'gpt-test',
    receivedAt,
    stateStartedAt: receivedAt,
    ...overrides
  } as AgentStatusIpcPayload
  const dispatchId = payload.orchestration?.dispatchId
  return mintFleetAgentStatusEvidence(payload, {
    ...(dispatchId ? { kind: 'worker' as const, dispatchId } : { kind: 'pane' as const }),
    terminalHandle: payload.terminalHandle ?? `term-${id}`,
    paneKey: payload.paneKey,
    processIncarnation
  })
}

describe('orchestration fleet projection', () => {
  it('uses fresh WSL host evidence without requiring an SSH connection', () => {
    const now = 10_000
    const result = projectOrchestrationFleet({
      workers: [
        worker('wsl', {
          resource: {
            id: 'resource-wsl',
            ownerDispatchId: 'wsl',
            worktreeId: 'folder-wsl',
            paneKey: 'tab-wsl:leaf-wsl',
            hostScope: JSON.stringify({ kind: 'wsl', hostId: 'local', distro: 'Ubuntu' }),
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: ''
          }
        })
      ],
      statuses: [status('wsl', now - 1)],
      now
    })
    expect(result.workers[0].liveness).toMatchObject({ verdict: 'live' })
    expect(result.workers[0].host).toEqual({ kind: 'local', id: 'local' })
  })

  it('composes durable identity with redacted push-fed status', () => {
    const now = 10_000
    const result = projectOrchestrationFleet({
      workers: [
        worker('1', {
          parentTaskId: 'task-parent',
          resource: {
            id: 'resource-1',
            ownerDispatchId: '1',
            worktreeId: 'folder-workspace',
            paneKey: 'tab-1:leaf-1',
            hostScope: '{"kind":"local","hostId":"local"}',
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [status('1', now - 1)],
      now
    })

    expect(result.workers[0]).toMatchObject({
      id: '1',
      role: 'worker',
      parent: { taskId: 'task-parent' },
      provider: { id: 'codex', model: 'gpt-test' },
      host: { kind: 'local', id: 'local' },
      workspace: { id: 'workspace-1', kind: 'folder_or_worktree' },
      stage: { activity: 'working' },
      liveness: { verdict: 'live' },
      resource: { state: 'owned', id: 'resource-1' }
    })
    expect(JSON.stringify(result)).not.toContain('secret transcript body')
  })

  it('keeps local folder and unsupervised rows instead of assuming git resources', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('folder', {
          workerState: 'unsupervised',
          worktreeId: 'folder:/project',
          terminalState: 'retained'
        })
      ],
      statuses: [],
      now: 1
    })

    expect(result.workers[0]).toMatchObject({
      workspace: { id: 'folder:/project', kind: 'folder_or_worktree' },
      host: { kind: 'local' },
      liveness: { verdict: 'unverifiable', reason: 'missing_status' },
      resource: { state: 'absent', reason: 'unsupervised' },
      nextAction: { kind: 'inspect' }
    })
  })

  it('treats null host scope on local folder authority as local', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('local-null-scope', {
          resource: {
            id: 'resource-local-null-scope',
            ownerDispatchId: 'local-null-scope',
            worktreeId: 'folder:/project',
            paneKey: 'tab-local-null-scope:leaf-local-null-scope',
            hostScope: null,
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [status('local-null-scope', 100)],
      now: 100
    })

    expect(result.workers[0]).toMatchObject({
      host: { kind: 'local', id: 'local' },
      liveness: { verdict: 'live' }
    })
  })

  it('does not promote stale or restored status to live evidence', () => {
    const now = 2_000_000
    const stale = projectOrchestrationFleet({
      workers: [worker('stale')],
      statuses: [status('stale', 1)],
      now
    }).workers[0]
    const restored = projectOrchestrationFleet({
      workers: [worker('restored')],
      statuses: [status('restored', now, { restoredUnconfirmed: true })],
      now
    }).workers[0]

    expect(stale.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'stale_status',
      observedAt: 1
    })
    expect(stale.provider).toEqual({ id: 'codex', model: 'gpt-test' })
    expect(restored.liveness).toMatchObject({
      verdict: 'unverifiable',
      reason: 'restored_unconfirmed'
    })
    expect(restored.evidence.liveStatus).toBe('redacted_restore')
  })

  it('does not treat a remote clock far ahead of the projection clock as live', () => {
    const result = projectOrchestrationFleet({
      workers: [worker('future')],
      statuses: [status('future', 10_000)],
      now: 1_000
    }).workers[0]

    expect(result?.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'future_status',
      observedAt: 10_000
    })
  })

  it('bounds 100-worker memory and paginates by stable Dispatch id', () => {
    const workers = Array.from({ length: 250 }, (_, index) => worker(`dispatch-${index}`))
    const first = projectOrchestrationFleet({ workers, statuses: [], limit: 10, now: 1 })
    const second = projectOrchestrationFleet({
      workers,
      statuses: [],
      cursor: first.page.nextCursor ?? undefined,
      limit: 500,
      now: 1
    })

    expect(first.workers).toHaveLength(10)
    expect(first.page).toMatchObject({
      total: 250,
      hasMore: true,
      nextCursor: 'dispatch-9'
    })
    expect(second.workers).toHaveLength(ORCHESTRATION_FLEET_PAGE_MAX)
    expect(second.workers[0]?.id).toBe('dispatch-10')
    expect(second.workers.at(-1)?.id).toBe('dispatch-109')
  })

  it('suggests release only for reclaimable ownership', () => {
    const result = projectOrchestrationFleet({
      workers: [worker('done', { terminalState: 'reclaimable' })],
      statuses: [],
      now: 1
    })

    expect(result.workers[0]?.nextAction).toEqual({
      kind: 'release',
      argv: ['orchestration', 'worker-release', '--dispatch', 'done']
    })
  })

  it('does not join a status carrying another Dispatch onto a reused pane', () => {
    const result = projectOrchestrationFleet({
      workers: [worker('old', { paneKey: 'reused:pane', agentTerminalHandle: 'term-reused' })],
      statuses: [
        status('reused', 100, {
          paneKey: 'reused:pane',
          terminalHandle: 'term-reused',
          orchestration: { taskId: 'task-new', dispatchId: 'new' }
        })
      ],
      now: 100
    })

    expect(result.workers[0]?.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'missing_status'
    })
    expect(result.workers[0]?.provider).toBeNull()
  })

  it('accepts a reminted pane when the Dispatch and terminal handle both match', () => {
    const durable = worker('dispatch-1', {
      paneKey: 'old-tab:old-leaf',
      agentTerminalHandle: 'term-worker',
      resource: {
        id: 'resource-1',
        ownerDispatchId: 'dispatch-1',
        worktreeId: null,
        paneKey: 'old-tab:old-leaf',
        processIncarnation: 'pty:inc-2',
        endpointId: 'runtime-1',
        endpointIncarnation: 'endpoint:inc-2',
        hostScope: '{"kind":"local","hostId":"local"}',
        ownershipState: 'owned',
        releaseState: 'not_requested',
        updatedAt: '2026-01-01T00:00:00Z'
      }
    })
    const result = projectOrchestrationFleet({
      workers: [durable],
      statuses: [
        status(
          'new',
          100,
          {
            paneKey: 'new-tab:new-leaf',
            terminalHandle: 'term-worker',
            orchestration: { taskId: 'task-dispatch-1', dispatchId: 'dispatch-1' }
          },
          'pty:inc-2'
        )
      ],
      now: 100
    })

    expect(result.workers[0]?.liveness.verdict).toBe('live')

    // A reminted pane is only accepted through the terminal handle; a foreign handle is not
    // this worker even when both the pane and the Dispatch would otherwise be reachable.
    expect(
      projectOrchestrationFleet({
        workers: [durable],
        statuses: [
          status(
            'new',
            100,
            {
              paneKey: 'new-tab:new-leaf',
              terminalHandle: 'term-other',
              orchestration: { taskId: 'task-dispatch-1', dispatchId: 'dispatch-1' }
            },
            'pty:inc-2'
          )
        ],
        now: 100
      }).workers[0]?.liveness.verdict
    ).toBe('unverifiable')
  })

  it('keeps provider-session-only status as identity without liveness evidence', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('session-only', {
          resource: {
            id: 'resource-session',
            ownerDispatchId: 'session-only',
            worktreeId: null,
            paneKey: 'tab-session:leaf-session',
            processIncarnation: 'pty:inc-1',
            endpointId: 'runtime-1',
            endpointIncarnation: 'endpoint:inc-1',
            hostScope: '{"kind":"local","hostId":"local"}',
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [
        status(
          'session-only',
          100,
          {
            providerSessionOnly: true,
            orchestration: { taskId: 'task-session-only', dispatchId: 'session-only' },
            providerSession: { key: 'session_id', id: 'session-1' }
          },
          'pty:inc-1'
        )
      ],
      now: 100
    })

    expect(result.workers[0]?.provider).toEqual({ id: 'codex', model: 'gpt-test' })
    expect(result.workers[0]?.liveness).toMatchObject({ verdict: 'unverifiable' })
  })

  it('treats unknown or federated host scope as remote and unverifiable without endpoint proof', () => {
    const result = projectOrchestrationFleet({
      workers: [
        worker('federated', {
          resource: {
            id: 'resource-federated',
            ownerDispatchId: 'federated',
            worktreeId: null,
            paneKey: 'tab-federated:leaf-federated',
            hostScope: '{"kind":"federated","targetId":"host-unknown"}',
            ownershipState: 'owned',
            releaseState: 'not_requested',
            updatedAt: '2026-01-01T00:00:00Z'
          }
        })
      ],
      statuses: [status('federated', 100)],
      now: 100
    })

    expect(result.workers[0]?.host).toEqual({ kind: 'remote', id: 'host-unknown' })
    expect(result.workers[0]?.liveness.verdict).toBe('unverifiable')
  })
})

describe('fleet liveness and attention after a host verdict', () => {
  it('measures staleness on the evidence clock, not the replay delivery clock', () => {
    const now = 10 * AGENT_STATUS_STALE_AFTER_MS
    const replayed = projectOrchestrationFleet({
      workers: [worker('1')],
      // A relay reconnect restamps receivedAt to stay monotonic; the evidence is an hour old.
      statuses: [
        status('1', now - 1, { evidenceObservedAt: now - AGENT_STATUS_STALE_AFTER_MS - 60_000 })
      ],
      now
    })

    expect(replayed.workers[0]?.liveness).toMatchObject({
      verdict: 'unverifiable',
      reason: 'stale_status'
    })
    expect(replayed.workers[0]?.evidence.liveStatus).toBe('stale')
    expect(replayed.workers[0]?.attention.categories).toContain('stale')
  })

  it('keeps an unproven outcome unverifiable after the host reports live', () => {
    const now = 10_000
    const projected = projectOrchestrationFleet({
      workers: [worker('1', { outcome: 'finished_unverified' })],
      statuses: [status('1', now - 1)],
      now
    })
    const subject = projected.workers[0]!
    expect(subject.attention).toMatchObject({ requiresAction: true })
    expect(subject.attention.categories).toContain('unverifiable')

    subject.liveness = { verdict: 'live', observedAt: now, source: 'execution_host' }
    refreshOrchestrationFleetLivenessAttention(subject)

    expect(subject.attention.categories).toContain('unverifiable')
    expect(subject.attention.requiresAction).toBe(true)
  })

  it('drops a stale category the host verdict disproves', () => {
    const now = 10 * AGENT_STATUS_STALE_AFTER_MS
    const projected = projectOrchestrationFleet({
      workers: [worker('1', { outcome: 'in_progress' })],
      statuses: [status('1', now - AGENT_STATUS_STALE_AFTER_MS - 60_000)],
      now
    })
    const subject = projected.workers[0]!
    expect(subject.attention.categories).toContain('stale')

    subject.liveness = { verdict: 'live', observedAt: now, source: 'execution_host' }
    refreshOrchestrationFleetLivenessAttention(subject)

    expect(subject.attention).toEqual({ categories: [], requiresAction: false })
  })
  it('reports an operator-closed worker as exited, not as absence', () => {
    const now = 10_000
    const projected = projectOrchestrationFleet({
      workers: [
        worker('1', {
          workerState: 'failed',
          workerStage: 'process_exited',
          dispatchStatus: 'failed',
          terminationReason: 'operator_close'
        })
      ],
      statuses: [],
      now
    })
    // The same receipt used to carry `observation.status: exited` next to this verdict.
    expect(projected.workers[0]!.liveness).toEqual({
      verdict: 'exited',
      source: 'execution_host'
    })
  })

  it('sends a proven-dead worker that never settled to worker-read, not the worker-show loop', () => {
    const now = 10_000
    const projected = projectOrchestrationFleet({
      workers: [worker('1', { workerStage: 'process_exited' })],
      statuses: [],
      now
    })
    expect(projected.workers[0]!.nextAction).toEqual({
      kind: 'recover',
      argv: ['orchestration', 'worker-read', '--dispatch', '1']
    })
  })

  it('refuses to certify a process_exited stage whose cause was never observed', () => {
    const projected = projectOrchestrationFleet({
      workers: [
        worker('1', {
          workerStage: 'process_exited',
          workerState: 'failed',
          terminationReason: 'unknown'
        })
      ],
      statuses: [],
      now: 10_000
    })
    expect(projected.workers[0]!.liveness).toEqual({
      verdict: 'unverifiable',
      reason: 'missing_status'
    })
    expect(projected.workers[0]!.nextAction.kind).toBe('inspect')
  })

  it('certifies a process_exited stage whose exit was observed', () => {
    const projected = projectOrchestrationFleet({
      workers: [
        worker('1', {
          workerStage: 'process_exited',
          workerState: 'failed',
          terminationReason: 'exited'
        })
      ],
      statuses: [],
      now: 10_000
    })
    expect(projected.workers[0]!.liveness).toEqual({
      verdict: 'exited',
      source: 'execution_host'
    })
  })

  it('asks nothing of a live running worker instead of looping on worker-show', () => {
    const now = 10_000
    const projected = projectOrchestrationFleet({
      workers: [worker('1')],
      statuses: [status('1', now - 1_000)],
      now
    })
    expect(projected.workers[0]!.liveness.verdict).toBe('live')
    expect(projected.workers[0]!.nextAction).toEqual({ kind: 'none', argv: [] })
  })

  it('keeps an unverifiable worker on inspect: absence is never authority to stop', () => {
    const now = 10 * AGENT_STATUS_STALE_AFTER_MS
    const projected = projectOrchestrationFleet({
      workers: [worker('1')],
      statuses: [status('1', now - AGENT_STATUS_STALE_AFTER_MS - 60_000)],
      now
    })
    expect(projected.workers[0]!.liveness.verdict).toBe('unverifiable')
    expect(projected.workers[0]!.nextAction.kind).toBe('inspect')
  })

  it('leaves a worker blocked on a question inspectable rather than recoverable', () => {
    const projected = projectOrchestrationFleet({
      workers: [worker('1', { workerStage: 'process_exited', pendingInput: true })],
      statuses: [],
      now: 10_000
    })
    expect(projected.workers[0]!.nextAction.kind).toBe('inspect')
  })

  // The live worker-list row from a stopped worker: the same receipt proved the exit,
  // called it absence, and pointed back at the command that reported the settlement.
  it('never contradicts a proven exit on a stopped worker still owning its terminal', () => {
    const projected = projectOrchestrationFleet({
      workers: [
        worker('1', {
          workerState: 'stopped',
          dispatchStatus: 'completed',
          workerStage: 'process_stopped',
          outcome: 'outcome_unknown',
          terminalState: 'retained',
          resource: {
            id: 'resource-1',
            ownerDispatchId: '1',
            worktreeId: 'workspace-1',
            paneKey: 'tab-1:leaf-1',
            hostScope: null,
            ownershipState: 'owned',
            releaseState: 'active',
            updatedAt: '2026-09-04T00:00:00.000Z'
          }
        })
      ],
      statuses: [],
      now: 10_000
    })
    const row = projected.workers[0]!

    expect(row.liveness.verdict).toBe('exited')
    expect(row.attention.categories).not.toContain('unverifiable')
    expect(row.attention.requiresAction).toBe(false)
    expect(row.nextAction).toEqual({
      kind: 'release',
      argv: ['orchestration', 'worker-release', '--dispatch', '1']
    })
  })

  it('asks nothing more of a settled worker whose terminal is already released', () => {
    const projected = projectOrchestrationFleet({
      workers: [
        worker('1', {
          workerState: 'stopped',
          dispatchStatus: 'completed',
          outcome: 'outcome_unknown',
          terminalState: 'retained',
          resource: {
            id: 'resource-1',
            ownerDispatchId: '1',
            worktreeId: 'workspace-1',
            paneKey: 'tab-1:leaf-1',
            hostScope: null,
            ownershipState: 'user_owned',
            releaseState: 'active',
            updatedAt: '2026-09-04T00:00:00.000Z'
          }
        })
      ],
      statuses: [],
      now: 10_000
    })

    expect(projected.workers[0]!.nextAction).toEqual({ kind: 'none', argv: [] })
  })
})
