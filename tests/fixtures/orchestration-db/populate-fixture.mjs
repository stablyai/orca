// Writes one fixture DB with the RELEASE TAG's own OrchestrationDb. generate-fixtures.mjs bundles
// this file inside a throwaway worktree checked out at that tag, so the bytes on disk are the
// schema and the row shapes that tag really shipped -- not the current schema stamped backwards.
import { writeFileSync } from 'node:fs'
import { OrchestrationDb } from '../../../src/main/runtime/orchestration/db'

const PRINCIPALS = {
  coordinatorHandle: 'coordinator-alpha',
  coordinatorPaneKey: 'tab-coordinator:11111111-1111-4111-8111-111111111111',
  workerHandle: 'worker-beta',
  workerPaneKey: 'tab-worker:22222222-2222-4222-8222-222222222222',
  plainSenderHandle: 'terminal-gamma',
  plainRecipientHandle: 'terminal-delta',
  homePeerFingerprint: 'home-peer-fixture',
  federatedDispatchId: 'ctx_federated_fixture',
  federatedTaskId: 'task_federated_fixture',
  directMailId: 'msg_fixture_direct',
  runMailId: 'msg_fixture_run_mailbox'
}

function createDispatch(db, taskId, shape) {
  if (shape.dispatchArguments === 'positional') {
    return db.createDispatchContext(taskId, PRINCIPALS.workerHandle, PRINCIPALS.workerPaneKey)
  }
  return db.createDispatchContext({
    taskId,
    assigneeHandle: PRINCIPALS.workerHandle,
    assigneePaneKey: PRINCIPALS.workerPaneKey,
    creator: {
      kind: 'terminal',
      handle: PRINCIPALS.coordinatorHandle,
      paneKey: PRINCIPALS.coordinatorPaneKey
    },
    maxDepth: 3
  })
}

function createAttachment(db, shape, runId) {
  const params = {
    dispatchId: PRINCIPALS.federatedDispatchId,
    taskId: PRINCIPALS.federatedTaskId,
    homePeerFingerprint: PRINCIPALS.homePeerFingerprint,
    protocolVersion: 1,
    runtimeEpoch: 'epoch-fixture',
    mutationReceipt: {
      callerFingerprint: PRINCIPALS.homePeerFingerprint,
      requestId: 'request_fixture_attachment',
      method: 'orchestration.federationAttachStart',
      payloadHash: 'payload_fixture_attachment'
    }
  }
  // A pre-v40 host puts no Run id on an attachment; current code must backfill a stub home Run.
  return db.createRemoteDispatchAttachment(
    shape.attachmentCarriesRunId ? { ...params, runId } : params
  )
}

function tableRowCounts(db) {
  const counts = {}
  const tables = db.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
  for (const { name } of tables) {
    counts[name] = db.db.prepare(`SELECT COUNT(*) AS total FROM "${name}"`).get().total
  }
  return counts
}

function assertPopulated(dispatch, taskId, messages) {
  if (dispatch.task_id !== taskId || dispatch.assignee_handle !== PRINCIPALS.workerHandle) {
    throw new Error(`Dispatch not bound to ${PRINCIPALS.workerHandle}: ${JSON.stringify(dispatch)}`)
  }
  if (messages.some((message) => message.read !== 0)) {
    throw new Error('Fixture mail must be unread')
  }
  const directMail = messages.find((message) => message.id === PRINCIPALS.directMailId)
  if (directMail && directMail.to_handle !== PRINCIPALS.plainRecipientHandle) {
    throw new Error(`Direct mail was rerouted to ${directMail.to_handle}`)
  }
}

export function populateFixture(dbPath, shape) {
  const db = new OrchestrationDb(dbPath)
  try {
    const run = db.createRun({
      objective: 'Shipped-schema fixture run',
      coordinatorHandle: PRINCIPALS.coordinatorHandle,
      coordinatorPaneKey: PRINCIPALS.coordinatorPaneKey
    })
    const task = db.createTask({ spec: 'Shipped-schema fixture task', runId: run.id })
    const dispatch = createDispatch(db, task.id, shape)
    const messages = []
    if (shape.includeUnboundDirectMail) {
      // No runId on purpose: each tag's own fallback decides where unbound direct mail lands.
      messages.push(
        db.insertMessage({
          id: PRINCIPALS.directMailId,
          from: PRINCIPALS.plainSenderHandle,
          to: PRINCIPALS.plainRecipientHandle,
          subject: 'Unbound direct mail'
        })
      )
    }
    messages.push(
      db.insertMessage({
        id: PRINCIPALS.runMailId,
        from: PRINCIPALS.workerHandle,
        to: `run:${run.id}`,
        subject: 'Run mailbox mail',
        runId: run.id
      })
    )
    const attachment = createAttachment(db, shape, run.id)
    assertPopulated(dispatch, task.id, messages)

    const expected = {
      runIds: [run.id],
      taskIds: [task.id],
      dispatchIds: [dispatch.id],
      messages: messages.map((message) => ({
        id: message.id,
        to: message.to_handle,
        read: message.read,
        run_id: message.run_id
      })),
      legacyAdoptionsCount: db.db.prepare('SELECT COUNT(*) AS total FROM legacy_adoptions').get()
        .total,
      attachments: [{ dispatchId: attachment.dispatch_id, taskId: attachment.task_id }],
      userVersion: db.db.pragma('user_version', { simple: true }),
      tableRowCounts: tableRowCounts(db)
    }
    db.db.pragma('wal_checkpoint(TRUNCATE)')
    db.db.exec('VACUUM')
    return expected
  } finally {
    db.close()
  }
}

const [dbPath, shapeJson, expectedOutPath] = process.argv.slice(2)
writeFileSync(
  expectedOutPath,
  `${JSON.stringify(populateFixture(dbPath, JSON.parse(shapeJson)), null, 2)}\n`
)
