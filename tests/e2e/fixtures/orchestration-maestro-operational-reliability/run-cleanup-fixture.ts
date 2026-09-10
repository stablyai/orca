import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitExecFileAsync } from '../../../../src/main/git/runner'
import { OrchestrationDb } from '../../../../src/main/runtime/orchestration/db/orchestration-db'
import { DispatchTranscriptStore } from '../../../../src/main/runtime/orchestration/db/dispatch-transcript/dispatch-transcript-store'
import { settleRunOwnedChildWorktrees } from '../../../../src/main/runtime/orchestration/run-owned-child-worktree-settlement'
import { collectRunOwnedChildWorktrees } from '../../../../src/shared/runtime-worktree-contracts'
import type { RuntimeWorktreePsSummary } from '../../../../src/shared/runtime-worktree-contracts'

const launchProfile = {
  agent: 'codex' as const,
  model: 'gpt-5.6-sol',
  effort: 'high',
  permissionMode: 'yolo',
  routeRef: null
}

const terminal = {
  executionHostId: 'local',
  workspaceKey: 'folder:career-ops',
  terminalHandle: 'term-career-ops',
  paneKey: 'tab-career-ops:leaf-career-ops',
  ptyIncarnation: 'pty:career-ops',
  processRootId: 'pid:career-ops'
}

function createSettledPredecessor(database: OrchestrationDb) {
  database.db
    .prepare(
      `INSERT INTO worker_terminal_resources (
        id, origin_dispatch_id, owner_dispatch_id, terminal_handle, pane_key,
        process_incarnation, host_scope, ownership_state, release_state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'owned', 'not_requested')`
    )
    .run(
      'resource-predecessor',
      'dispatch-predecessor',
      'dispatch-predecessor',
      terminal.terminalHandle,
      terminal.paneKey,
      terminal.ptyIncarnation,
      'local'
    )
  database.db
    .prepare("INSERT INTO worker_dispatches (dispatch_id, state) VALUES (?, 'succeeded')")
    .run('dispatch-predecessor')
  const lease = database.reserveMaestroTerminalLease({
    requestId: 'worker:dispatch-predecessor',
    executionHostId: terminal.executionHostId,
    workspaceKey: terminal.workspaceKey,
    runId: 'run-career-ops',
    taskId: 'task-predecessor',
    attemptId: 'attempt-predecessor',
    role: 'worker',
    workerTerminalResourceId: 'resource-predecessor',
    title: 'Career Ops predecessor',
    launchProfile,
    spawnedBy: 'coordinator:g1',
    ownerPrincipal: 'dispatch:dispatch-predecessor',
    retentionPolicy: 'auto_release'
  })
  database.attachMaestroTerminalLease({
    leaseId: lease.id,
    tabId: 'tab-career-ops',
    ...terminal
  })
  database.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'ready' })
  database.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'active' })
  database.transitionMaestroTerminalLease({ leaseId: lease.id, state: 'settled' })
  return lease
}

export function exerciseSessionTransferAndRestart(root: string) {
  const databasePath = join(root, 'orchestration.sqlite')
  let database = new OrchestrationDb(databasePath)
  const predecessor = createSettledPredecessor(database)
  let transcripts = new DispatchTranscriptStore(database)
  transcripts.startSegment({
    dispatchId: 'dispatch-predecessor',
    leaseId: predecessor.id,
    runId: 'run-career-ops',
    taskId: 'task-predecessor',
    attemptId: 'attempt-predecessor',
    startCursor: 0,
    ...terminal
  })
  transcripts.appendEntries({
    dispatchId: 'dispatch-predecessor',
    terminal,
    entries: [{ cursor: 0, payload: 'predecessor output' }]
  })
  const leaseTransfer = database.transferMaestroWorkerTerminalLease({
    requestId: 'lease-transfer-career-ops',
    predecessorLeaseId: predecessor.id,
    successorRequestId: 'worker:dispatch-successor',
    kind: 'settled_resource_reuse',
    successorDispatchId: 'dispatch-successor',
    runId: 'run-career-ops',
    taskId: 'task-successor',
    attemptId: 'attempt-successor',
    hostScope: 'local',
    predecessorOwnerPrincipal: 'dispatch:dispatch-predecessor',
    successorOwnerPrincipal: 'dispatch:dispatch-successor',
    coordinatorGeneration: 1,
    retentionPolicy: 'auto_release',
    title: 'Career Ops successor',
    launchProfile,
    spawnedBy: 'coordinator:g1',
    ...terminal
  })
  const transcriptTransfer = transcripts.transferSegment({
    requestId: 'transcript-transfer-career-ops',
    leaseTransferRequestId: leaseTransfer.requestId,
    predecessorDispatchId: 'dispatch-predecessor',
    predecessorLeaseId: predecessor.id,
    successorDispatchId: 'dispatch-successor',
    successorLeaseId: leaseTransfer.successorLeaseId,
    successorRunId: 'run-career-ops',
    successorTaskId: 'task-successor',
    successorAttemptId: 'attempt-successor',
    transferCursor: 1,
    ...terminal
  })
  transcripts.appendEntries({
    dispatchId: 'dispatch-successor',
    terminal,
    entries: [{ cursor: 1, payload: 'successor output' }]
  })
  const activeRead = transcripts.read({ dispatchId: 'dispatch-successor' })
  const predecessorRead = transcripts.read({
    dispatchId: 'dispatch-successor',
    selector: { kind: 'predecessor', dispatchId: 'dispatch-predecessor' }
  })
  database.close()
  database = new OrchestrationDb(databasePath)
  transcripts = new DispatchTranscriptStore(database)
  const replayed = transcripts.getTransferReceipt(transcriptTransfer.requestId)
  const restartedRead = transcripts.read({ dispatchId: 'dispatch-successor' })
  database.close()
  return {
    leaseTransferred: leaseTransfer.predecessorLeaseId === predecessor.id,
    activeRead: activeRead.entries.map((entry) => entry.payload),
    predecessorRead: predecessorRead.entries.map((entry) => entry.payload),
    restartPreserved: replayed?.successorDispatchId === 'dispatch-successor',
    restartedRead: restartedRead.entries.map((entry) => entry.payload)
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await gitExecFileAsync(args, { cwd })).stdout.trim()
}

export async function exerciseSettledChildWorktreeCleanup(): Promise<{
  selectedWorktreeCount: number
  firstDisposition: string
  replayDisposition: string
  childAbsent: boolean
  branchPreserved: boolean
}> {
  const root = mkdtempSync(join(tmpdir(), 'orca-omr-cleanup-'))
  const repoPath = join(root, 'repo')
  const childPath = join(root, 'child')
  mkdirSync(repoPath)
  await git(repoPath, 'init')
  await git(repoPath, 'config', 'user.email', 'omr@example.test')
  await git(repoPath, 'config', 'user.name', 'OMR fixture')
  writeFileSync(join(repoPath, 'README.md'), 'bounded cleanup fixture\n')
  await git(repoPath, 'add', 'README.md')
  await git(repoPath, 'commit', '-m', 'fixture')
  await git(repoPath, 'worktree', 'add', '-b', 'omr-child', childPath)

  const worktreeId = `omr-fixture::${childPath}`
  const owned = collectRunOwnedChildWorktrees([
    {
      effects: JSON.stringify([
        {
          kind: 'worktree',
          action: 'created_child',
          id: worktreeId,
          executionHostId: 'local',
          worktreeInstanceId: 'omr-fixture-instance'
        },
        { kind: 'worktree', action: 'created_top_level', id: 'omr-fixture::top' },
        { kind: 'worktree', action: 'reused', id: 'omr-fixture::reused' },
        { kind: 'folder', action: 'created_child', id: 'folder::foreign' }
      ])
    }
  ])
  let orcaRegistered = true

  const assertAbsent = async (): Promise<void> => {
    const gitRegistered = (await git(repoPath, 'worktree', 'list', '--porcelain')).includes(
      childPath
    )
    if (existsSync(childPath) || gitRegistered || orcaRegistered) {
      throw new Error('The checkout remains present in filesystem, Git, or Orca state.')
    }
  }
  const processEvidence = {
    queriedHostIds: new Set(['local' as const]),
    summaries: [
      {
        worktreeId,
        hostId: 'local',
        worktreeInstanceId: 'omr-fixture-instance',
        status: 'inactive',
        agents: [],
        liveTerminalCount: 1,
        hasAttachedPty: true
      } as RuntimeWorktreePsSummary
    ]
  }

  try {
    const selected = owned.worktrees[0]
    if (!selected || selected.worktreeId !== worktreeId || selected.executionHostId !== 'local') {
      throw new Error('The durable Run effect did not select the exact host-qualified child.')
    }
    const first = await settleRunOwnedChildWorktrees({
      runId: 'run-omr-cleanup',
      worktrees: owned.worktrees,
      unreadableEffectRows: owned.unreadableEffectRows,
      processEvidence,
      authority: {
        assertAbsent,
        retentionCause: () => undefined,
        remove: async () => {
          await git(repoPath, 'worktree', 'remove', '--force', childPath)
          orcaRegistered = false
          return { wasRegistered: true, reportedOk: false }
        }
      }
    })
    await assertAbsent()
    const replay = await settleRunOwnedChildWorktrees({
      runId: 'run-omr-cleanup',
      worktrees: owned.worktrees,
      unreadableEffectRows: owned.unreadableEffectRows,
      processEvidence: { ...processEvidence, summaries: [] },
      authority: {
        assertAbsent,
        retentionCause: () => undefined,
        remove: async () => {
          throw new Error('Replay must not repeat checkout removal.')
        }
      }
    })
    return {
      selectedWorktreeCount: owned.worktrees.length,
      firstDisposition: first.worktrees[0]?.disposition ?? 'pending',
      replayDisposition: replay.worktrees[0]?.disposition ?? 'pending',
      childAbsent: true,
      branchPreserved: (await git(repoPath, 'branch', '--list', 'omr-child')) === 'omr-child'
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}
