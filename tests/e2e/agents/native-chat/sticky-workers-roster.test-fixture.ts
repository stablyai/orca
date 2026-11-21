import { randomUUID } from 'node:crypto'
import { OrchestrationDb } from '../../../../src/main/runtime/orchestration/db/orchestration-db'
import { isOrcaSessionId } from '../../../../src/shared/agent-session/identity/orca-session-address'
import { approvalReportId } from '../../../../src/main/runtime/orchestration/workers/approvals/worker-approval-report'

/** Synthetic lifecycle records in the harness's disposable profile; no agent or terminal is launched. */
export function seedStickyWorkers(file: string, session: string, count: number, asks = false) {
  const db = new OrchestrationDb(file)
  try {
    seedStickyWorkerRecords(db, session, count, asks)
  } finally {
    db.close()
  }
}

export function seedStickyWorkerRecords(
  db: OrchestrationDb,
  session: string,
  count: number,
  asks = false,
  options: { failures?: number; remote?: boolean } = {}
) {
  if (!isOrcaSessionId(session)) {
    throw new Error('The capture needs a structured source session.')
  }
  const run = db.createRun({
    objective: 'Synthetic sticky workers capture',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: session
  })
  for (let index = 0; index < count; index++) {
    const task = db.createTask({ runId: run.id, spec: `Review journal writes ${index + 1}` })
    db.db
      .prepare('UPDATE tasks SET display_name = ?, task_title = ? WHERE id = ?')
      .run(`ORCA-${index + 1}`, `Review journal writes ${index + 1}`, task.id)
    const { dispatch } = db.createStartingWorkerDispatch({
      creator: { kind: 'session', orcaSessionId: session },
      maxDepth: 10,
      taskId: task.id,
      startOptions: {
        agent: 'codex',
        launch: { effective: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' } }
      }
    })
    const handle = `term_sticky_capture_${session}_${index}`
    db.prepareStartingWorkerAuthority({
      dispatchId: dispatch.id,
      handle,
      paneKey: `sticky-${index}:${randomUUID()}`,
      processIncarnation: `sticky-${index}`,
      worktreeId: 'synthetic-capture-folder',
      setupState: 'not_applicable',
      effects: []
    })
    if (options.remote && index === 0) {
      db.db
        .prepare(`INSERT INTO federated_dispatches(dispatch_id, environment_id, environment_name, peer_fingerprint)
        VALUES (?, 'synthetic-remote', 'Remote capture host', 'synthetic-peer')`)
        .run(dispatch.id)
    }
    db.markWorkerDispatchReady(dispatch.id)
    if (asks) {
      const approvalId = `apr_sticky_${index}`
      db.insertMessage({
        id: approvalReportId(dispatch.id, approvalId, 'open'),
        runId: run.id,
        from: handle,
        to: `orca_session_id:${session}`,
        type: 'escalation',
        subject: 'Worker is waiting for permission',
        body: 'Allow verification?',
        payload: JSON.stringify({
          dispatchId: dispatch.id,
          approval: {
            v: 1,
            approvalId,
            state: 'open',
            worker: { handle, dispatchId: dispatch.id, taskId: task.id },
            summary: {
              title: 'Allow verification?',
              detail: 'Run the verification command before finishing.',
              reason: null
            },
            allowedActions: ['allow', 'deny'],
            personOnly: true
          }
        })
      })
      db.db
        .prepare(
          "UPDATE messages SET read = 1, delivered_at = datetime('now'), created_at = ? WHERE id = ?"
        )
        .run(
          new Date(Date.now() - (count - index) * 60_000).toISOString(),
          approvalReportId(dispatch.id, approvalId, 'open')
        )
    } else if (index < (options.failures ?? 0) || (index === 1 && count > 2)) {
      saveFailedReport(db, session, task.id, dispatch.id)
    }
  }
}

export function failStickyWorker(file: string, session: string): string {
  const db = new OrchestrationDb(file)
  try {
    return failStickyWorkerRecord(db, session)
  } finally {
    db.close()
  }
}

export function failStickyWorkerRecord(db: OrchestrationDb, session: string): string {
  const candidate = db.db
    .prepare(
      `SELECT w.dispatch_id, d.task_id FROM worker_dispatches w JOIN dispatch_contexts d ON d.id = w.dispatch_id WHERE d.creator_orca_session_id = ? AND w.state = 'ready' LIMIT 1`
    )
    .get(session)
  if (
    !candidate ||
    typeof candidate.dispatch_id !== 'string' ||
    typeof candidate.task_id !== 'string'
  ) {
    throw new Error('No synthetic ready worker remains.')
  }
  saveFailedReport(db, session, candidate.task_id, candidate.dispatch_id)
  return candidate.dispatch_id
}

function saveFailedReport(
  db: OrchestrationDb,
  session: string,
  taskId: string,
  dispatchId: string
) {
  const body = 'Verification command exited with code 1.'
  db.settleWorkerReport({ taskId, dispatchId, outcome: 'failed', result: body })
  const id = `msg_sticky_${randomUUID()}`
  db.insertMessage({
    id,
    from: 'term_sticky_capture',
    to: `orca_session_id:${session}`,
    type: 'worker_done',
    subject: 'Verification failed',
    body,
    payload: JSON.stringify({ outcome: 'failed' })
  })
  db.db.prepare("UPDATE messages SET read = 1, delivered_at = datetime('now') WHERE id = ?").run(id)
  db.recordAttemptObservation({
    id: `worker_report:${id}`,
    dispatchId,
    sequence: 1,
    authorityId: 'run_home:sticky_capture',
    authorityClock: 'home',
    facet: 'worker_report',
    payload: { status: 'accepted', outcome: 'failed' },
    homeReceivedAt: Date.now()
  })
}
