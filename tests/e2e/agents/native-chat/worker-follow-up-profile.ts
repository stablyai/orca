import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openJournalDomainDatabase } from '../../../../src/main/native-chat/agent-session-journal/database/journal-domain-database'
import { journalDomainDatabasePath } from '../../../../src/main/native-chat/agent-session-journal/database/journal-host-database'
import { OrchestrationDb } from '../../../../src/main/runtime/orchestration/db/orchestration-db'
import {
  agentSessionRecordFixture,
  agentSessionLeaseFixture
} from '../../../../src/shared/agent-session/lifecycle/records/agent-session-record.test-fixture'
import { encodeAgentSessionRecord } from '../../../../src/shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import { structuredAgentSessionTabId } from '../../../../src/shared/agent-session/view/structured-agent-session-projection'
import { testOrcaSessionId } from '../../../../src/shared/agent-session/identity/orca-session-address-test-fixture'
import {
  mintStructuredWorkerHandle,
  mintStructuredWorkerPaneKey,
  structuredWorkerProcessIncarnation
} from '../../../../src/main/runtime/orchestration/terminal-authority/structured-sessions/structured-worker-identity'

/** Persist the state a restart sees, using production assignment/custody transitions. */
export async function seedWorkerFollowUpProfile(userDataDir: string, worktreeId: string) {
  const coordinator = testOrcaSessionId(randomUUID())
  // The chats the app reads: the first launch created this file.
  const journal = openJournalDomainDatabase(journalDomainDatabasePath(userDataDir))
  const db = new OrchestrationDb(path.join(userDataDir, 'orchestration.db'))
  const records = [coordinator]
  const run = db.createRun({
    objective: 'Worker provider regression',
    coordinatorHandle: null,
    coordinatorPaneKey: null,
    coordinatorOrcaSessionId: coordinator
  })
  const expected: { dispatchId: string; agent: string; title: string }[] = []
  try {
    for (const [agent, followUp] of [
      ['codex', true],
      ['claude', true],
      ['codex', false]
    ] as const) {
      const sessionId = testOrcaSessionId(randomUUID())
      records.push(sessionId)
      const record = agentSessionRecordFixture(
        agentSessionLeaseFixture({
          sessionId,
          claimStatus: 'released',
          runtimeFence: 1,
          ownerProcess: null,
          reservedSpawnToken: null,
          provenHandleLinkId: null,
          leaseDeadlineAt: 0,
          lastRenewedAt: 0
        })
      )
      record.provider = agent
      record.providerHandleChain = []
      record.accountHome = {
        variable: agent === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
        path: path.join(userDataDir, 'fixture-account', agent)
      }
      record.location = {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: worktreeId,
        workspaceKind: 'git-worktree'
      }
      journal.db
        .prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
        .run(sessionId, JSON.stringify(encodeAgentSessionRecord(record)))
      const handle = mintStructuredWorkerHandle()
      const paneKey = mintStructuredWorkerPaneKey(sessionId)
      const authority = {
        handle,
        paneKey,
        processIncarnation: structuredWorkerProcessIncarnation(sessionId),
        worktreeId,
        hostScope: JSON.stringify({ kind: 'local', hostId: 'local' }),
        effects: [],
        setupState: 'not_applicable'
      }
      const start = (title: string, prior?: string) => {
        const started = db.createStartingWorkerDispatch({
          creator: { kind: 'session', orcaSessionId: coordinator },
          maxDepth: 9,
          taskSpec: title,
          taskTitle: title,
          taskRunId: run.id,
          startOptions: { agent: prior ? null : agent },
          followUpOf: prior
        })
        db.prepareStartingWorkerAuthority({
          ...authority,
          dispatchId: started.dispatch.id,
          terminalOwnership: prior ? 'external' : 'created'
        })
        db.markWorkerDispatchReady(started.dispatch.id)
        return started
      }
      let current = start(`Initial ${agent} research`)
      if (followUp) {
        db.keepWorkerTerminalOpen(paneKey)
        for (let turn = 1; turn <= 2; turn += 1) {
          db.settleWorkerReport({
            taskId: current.task.id,
            dispatchId: current.dispatch.id,
            outcome: 'succeeded',
            result: 'Research finished'
          })
          current = start(`${agent} research follow-up ${turn}`, current.dispatch.id)
        }
      }
      expected.push({ dispatchId: current.dispatch.id, agent, title: current.task.task_title! })
    }
    const parent = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: coordinator,
        claimStatus: 'released',
        runtimeFence: 1,
        ownerProcess: null,
        reservedSpawnToken: null,
        provenHandleLinkId: null,
        leaseDeadlineAt: 0,
        lastRenewedAt: 0
      })
    )
    parent.location = {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: worktreeId,
      workspaceKind: 'git-worktree'
    }
    parent.providerHandleChain = []
    parent.accountHome = {
      variable: 'CLAUDE_CONFIG_DIR',
      path: path.join(userDataDir, 'fixture-account', 'claude')
    }
    journal.db
      .prepare('INSERT INTO agent_session_records (session_id, record_json) VALUES (?, ?)')
      .run(coordinator, JSON.stringify(encodeAgentSessionRecord(parent)))
    records.forEach((sessionId, position) =>
      journal.db
        .prepare('INSERT INTO agent_session_tabs (tab_id, session_id, position) VALUES (?, ?, ?)')
        .run(structuredAgentSessionTabId(sessionId), sessionId, position)
    )
    journal.db
      .prepare(
        "INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES ('session_tabs_recorded', '1')"
      )
      .run()
    return { coordinator, expected }
  } finally {
    db.close()
    journal.db.close()
  }
}
