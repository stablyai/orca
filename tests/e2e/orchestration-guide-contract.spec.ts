import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import { FAKE_AGENT_WINDOWS_SHELL } from './helpers/fake-agent-command-override'
import { countLegacyAdoptions, readMailRowsById } from './helpers/orchestration-mail-store'
import {
  createOrchestrationCli,
  describeRun,
  payload,
  receipt,
  type OrchestrationCli
} from './helpers/orchestration-guide-cli'
import {
  createGuideCommandLedger,
  findGuideCoverageGaps,
  findStaleExcuses
} from './helpers/orchestration-guide-command-ledger'
import {
  createGuideContractFakeAgent,
  fakeAgentLaunchEnv
} from './helpers/orchestration-guide-fake-agent'
import {
  createAgentTerminal,
  createPeerTerminalPty,
  handleForPty,
  resolveActivePaneHandle,
  waitForRegisteredWorktree
} from './helpers/orchestration-guide-terminal-topology'

const agent = createGuideContractFakeAgent()
const ledger = createGuideCommandLedger()

async function applyFakeAgentSettings(page: Page): Promise<void> {
  await page.evaluate(
    async ({ agentCommand, terminalWindowsShell }) => {
      await window.__store?.getState().updateSettings({
        agentCmdOverrides: { codex: agentCommand },
        terminalWindowsShell
      })
    },
    { agentCommand: agent.command, terminalWindowsShell: FAKE_AGENT_WINDOWS_SHELL }
  )
}

async function readUserDataDir(app: ElectronApplication): Promise<string> {
  return await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
}

test.afterAll(() => {
  agent.cleanup()
})

test('runs the orchestration guide sequence through the compiled CLI across a restart', async (// oxlint-disable-next-line no-empty-pattern -- this spec owns both Electron launches and opts out of the shared app fixture.
{}, testInfo) => {
  test.setTimeout(600_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  agent.reset()
  const session = createRestartSession(testInfo, fakeAgentLaunchEnv(agent))
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    // ── Launch 1: two terminals, neither in a Run ────────────────────────────
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    const userDataDir = await readUserDataDir(first.app)
    const orca: OrchestrationCli = createOrchestrationCli(userDataDir, ledger)
    const firstClient = new RuntimeClient(userDataDir, 30_000, null, null)
    await waitForRegisteredWorktree(firstClient, worktreeId)
    await applyFakeAgentSettings(first.page)

    const coordinator = await resolveActivePaneHandle(first.page, firstClient)
    const peerPtyId = await createPeerTerminalPty(firstClient, worktreeId)
    const peer = await handleForPty(firstClient, peerPtyId)

    // (a) The #19542 command: a sender in NO Run mailing a bare handle.
    const sent = receipt<{ message: { id: string; run_id?: string } }>(
      orca(coordinator, [
        'orchestration',
        'send',
        '--to',
        peer,
        '--subject',
        'Guide contract: plain terminal mail',
        '--body',
        'Sent before any Run exists.',
        '--json'
      ])
    )
    const unboundMessageId = sent.message.id
    expect(unboundMessageId).toMatch(/^msg_/)
    expect(readMailRowsById(userDataDir, [unboundMessageId])).toEqual([
      expect.objectContaining({ run_id: 'run_unbound', to_handle: peer, read: 0 })
    ])

    // (b) The recipient reads it, replies, and the sender sees the reply on the same thread.
    const checked = receipt<{ messages: { id: string; subject?: string }[]; count: number }>(
      orca(peer, ['orchestration', 'check', '--terminal', peer, '--json'])
    )
    expect(checked.messages.map((message) => message.id)).toContain(unboundMessageId)
    const replied = receipt<{ message: { id: string } }>(
      orca(peer, [
        'orchestration',
        'reply',
        '--id',
        unboundMessageId,
        '--body',
        'Reply from the second plain terminal.',
        '--json'
      ])
    )
    const replyId = replied.message.id
    const coordinatorInbox = receipt<{ messages: { id: string }[] }>(
      orca(coordinator, ['orchestration', 'check', '--terminal', coordinator, '--json'])
    )
    expect(coordinatorInbox.messages.map((message) => message.id)).toContain(replyId)
    const threadRows = readMailRowsById(userDataDir, [unboundMessageId, replyId])
    expect(threadRows.find((row) => row.id === replyId)?.thread_id).toBe(unboundMessageId)

    // One more that nobody reads, so the restart has an UNREAD row to preserve.
    const pending = receipt<{ message: { id: string } }>(
      orca(coordinator, [
        'orchestration',
        'send',
        '--to',
        peer,
        '--subject',
        'Guide contract: survives the restart',
        '--body',
        'Never read before the restart.',
        '--json'
      ])
    )
    const pendingId = pending.message.id
    const rowsBeforeRestart = readMailRowsById(userDataDir, [unboundMessageId, replyId, pendingId])
    const adoptionsBeforeRestart = countLegacyAdoptions(userDataDir)

    // ── (c) Restart the runtime against the same profile ─────────────────────
    await session.close(firstApp)
    firstApp = null
    const second = await session.launch()
    secondApp = second.app
    const client = new RuntimeClient(session.userDataDir, 30_000, null, null)
    await applyFakeAgentSettings(second.page)

    expect(readMailRowsById(userDataDir, [unboundMessageId, replyId, pendingId])).toEqual(
      rowsBeforeRestart
    )
    expect(countLegacyAdoptions(userDataDir)).toBe(adoptionsBeforeRestart)
    const restoredPeer = await handleForPty(client, peerPtyId)
    const afterRestart = receipt<{ messages: { id: string }[]; formatted?: string }>(
      orca(restoredPeer, [
        'orchestration',
        'check',
        '--terminal',
        restoredPeer,
        '--peek',
        '--format',
        '--json'
      ])
    )
    expect(afterRestart.messages.map((message) => message.id)).toContain(pendingId)
    expect(afterRestart.formatted).toContain('Guide contract: survives the restart')
    // --peek is read-only: the row it just returned is still unread.
    expect(readMailRowsById(userDataDir, [pendingId])[0]?.read).toBe(0)

    const restoredCoordinator = await resolveActivePaneHandle(second.page, client)
    const inbox = receipt<{ messages: { id: string }[] }>(
      orca(restoredCoordinator, ['orchestration', 'inbox', '--full', '--json'])
    )
    expect(inbox.messages.map((message) => message.id)).toEqual(
      expect.arrayContaining([unboundMessageId, replyId, pendingId])
    )

    // ── (d) Bind a Run, plan Tasks, start a supervised worker ────────────────
    const run = receipt<{ run: { id: string; objective: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'run-create',
        '--objective',
        'Execute the orchestration guide sequence',
        '--json'
      ])
    )
    const runId = run.run.id
    expect(runId).toMatch(/^run_/)
    expect(run.run.objective).toBe('Execute the orchestration guide sequence')

    const runList = receipt<{ runs: { id: string }[] }>(
      orca(restoredCoordinator, ['orchestration', 'run-list', '--json'])
    )
    expect(runList.runs.map((entry) => entry.id)).toContain(runId)
    const runShow = receipt<{ run: { id: string } }>(
      orca(restoredCoordinator, ['orchestration', 'run-show', '--id', runId, '--json'])
    )
    expect(runShow.run.id).toBe(runId)
    const rebound = receipt<{ run: { id: string } }>(
      orca(restoredCoordinator, ['orchestration', 'run-use', '--id', runId, '--json'])
    )
    expect(rebound.run.id).toBe(runId)

    const firstTask = receipt<{ task: { id: string; status: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'task-create',
        '--spec',
        'Guide contract: the dependency-free Task',
        '--json'
      ])
    )
    const dependentTask = receipt<{ task: { id: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'task-create',
        '--spec',
        'Guide contract: the dependent Task',
        '--deps',
        JSON.stringify([firstTask.task.id]),
        '--json'
      ])
    )
    const readyTasks = receipt<{ tasks: { id: string }[] }>(
      orca(restoredCoordinator, ['orchestration', 'task-list', '--ready', '--brief', '--json'])
    )
    expect(readyTasks.tasks.map((task) => task.id)).toContain(firstTask.task.id)
    expect(readyTasks.tasks.map((task) => task.id)).not.toContain(dependentTask.task.id)
    const runTasks = receipt<{ tasks: { id: string }[] }>(
      orca(restoredCoordinator, ['orchestration', 'task-list', '--run', runId, '--json'])
    )
    expect(runTasks.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([firstTask.task.id, dependentTask.task.id])
    )

    const started = receipt<{
      taskId: string
      dispatchId: string
      effects: { kind: string; role?: string; id?: string }[]
    }>(
      orca(restoredCoordinator, [
        'orchestration',
        'worker-start',
        '--spec',
        'Guide contract: the supervised worker',
        '--worktree',
        'current',
        '--agent',
        'codex',
        '--json'
      ])
    )
    const worker = started.effects.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'agent'
    )?.id
    expect(worker, JSON.stringify(started)).toBeTruthy()
    const workerHandle = worker as string
    const taskId = started.taskId
    const dispatchId = started.dispatchId
    expect(taskId).toMatch(/^task_/)
    expect(dispatchId).toEqual(expect.any(String))

    // The capability the worker must copy comes from the preamble it received.
    await expect
      .poll(() => agent.readStdin(workerHandle), {
        timeout: 60_000,
        message: 'the worker pane never received a preamble carrying a Dispatch capability'
      })
      .toMatch(/--dispatch-capability dcap_/)
    const capability = agent
      .readStdin(workerHandle)
      .match(/--dispatch-capability (dcap_[A-Za-z0-9_-]+)/)?.[1] as string

    // ── (e) The worker's own contract ────────────────────────────────────────
    const workerCheck = receipt<{ count: number }>(
      orca(workerHandle, ['orchestration', 'check', '--terminal', workerHandle, '--json'])
    )
    expect(workerCheck.count).toBeGreaterThanOrEqual(0)
    const heartbeat = orca(workerHandle, [
      'orchestration',
      'send',
      '--from',
      workerHandle,
      '--dispatch-capability',
      capability,
      '--type',
      'heartbeat',
      '--subject',
      'alive',
      '--task-id',
      taskId,
      '--dispatch-id',
      dispatchId,
      '--phase',
      'implementing',
      '--json'
    ])
    expect(receipt<{ message?: { id: string }; relay?: unknown }>(heartbeat)).toBeTruthy()

    // ask blocks; a short timeout leaves the question durably pending with a resumable id.
    const askTimedOut = orca(workerHandle, [
      'orchestration',
      'ask',
      '--from',
      workerHandle,
      '--dispatch-capability',
      capability,
      '--question',
      'Guide contract: which option?',
      '--options',
      'left,right',
      '--timeout-ms',
      '4000',
      '--json'
    ])
    // A timed-out ask exits 1 by contract and still returns the pending question's identity.
    expect(askTimedOut.status, describeRun(askTimedOut)).toBe(1)
    const askReceipt = payload<{
      timedOut: boolean
      messageId: string | null
      answer: string | null
    }>(askTimedOut)
    expect(askReceipt.timedOut, describeRun(askTimedOut)).toBe(true)
    expect(askReceipt.messageId).toMatch(/^msg_/)
    const questionId = askReceipt.messageId as string

    // ── (f) The coordinator's delivery loop ──────────────────────────────────
    const firstDelivery = receipt<{
      deliveryId: string | null
      messages: { id: string; type?: string }[]
    }>(
      orca(restoredCoordinator, [
        'orchestration',
        'check',
        '--wait',
        '--types',
        'worker_done,escalation,question',
        '--timeout-ms',
        '60000',
        '--json'
      ])
    )
    expect(firstDelivery.deliveryId).toBeTruthy()
    expect(firstDelivery.messages.map((message) => message.id)).toContain(questionId)
    receipt<{ message: { id: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'reply',
        '--id',
        questionId,
        '--body',
        'left',
        '--json'
      ])
    )

    const resumed = receipt<{ answer: string | null; timedOut: boolean }>(
      orca(workerHandle, [
        'orchestration',
        'ask',
        '--from',
        workerHandle,
        '--dispatch-capability',
        capability,
        '--resume',
        questionId,
        '--timeout-ms',
        '60000',
        '--json'
      ])
    )
    expect(resumed.timedOut).toBe(false)
    expect(resumed.answer).toBe('left')

    // ── (g) Address forms the guide documents ────────────────────────────────
    const toRun = receipt<{ message: { id: string; run_id?: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'send',
        '--to',
        `run:${runId}`,
        '--subject',
        'Guide contract: Run mailbox',
        '--body',
        'Addressed to the Run home inbox.',
        '--json'
      ])
    )
    expect(readMailRowsById(userDataDir, [toRun.message.id])[0]?.run_id).toBe(runId)
    const toDispatch = receipt<{ message?: { id: string }; relay?: { dispatchId: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'send',
        '--to',
        `dispatch:${dispatchId}`,
        '--subject',
        'Follow-up',
        '--body',
        'Attempt-specific coordinator guidance.',
        '--json'
      ])
    )
    expect(toDispatch.message?.id ?? toDispatch.relay?.dispatchId).toBeTruthy()
    const toGroup = receipt<{ messages: { id: string }[]; recipients: number }>(
      orca(restoredCoordinator, [
        'orchestration',
        'send',
        '--to',
        '@all',
        '--subject',
        'Guide contract: group fan-out',
        '--body',
        'Intentional fan-out status.',
        '--json'
      ])
    )
    expect(toGroup.recipients).toBeGreaterThan(0)
    expect(toGroup.messages).toHaveLength(toGroup.recipients)
    const toWorktreeGroup = receipt<{ recipients: number }>(
      orca(restoredCoordinator, [
        'orchestration',
        'send',
        '--to',
        `@worktree:${worktreeId}`,
        '--subject',
        'Guide contract: worktree fan-out',
        '--body',
        'Intentional worktree fan-out.',
        '--json'
      ])
    )
    expect(toWorktreeGroup.recipients).toBeGreaterThan(0)

    // The worker reads coordinator follow-ups before it settles, as the contract requires.
    const workerFollowUp = receipt<{ messages: { subject?: string }[] }>(
      orca(workerHandle, ['orchestration', 'check', '--terminal', workerHandle, '--json'])
    )
    expect(workerFollowUp.messages.map((message) => message.subject)).toContain('Follow-up')

    const escalation = orca(workerHandle, [
      'orchestration',
      'send',
      '--from',
      workerHandle,
      '--dispatch-capability',
      capability,
      '--type',
      'escalation',
      '--subject',
      'Blocked: guide contract escalation',
      '--body',
      'Escalating before completion.',
      '--task-id',
      taskId,
      '--dispatch-id',
      dispatchId,
      '--json'
    ])
    expect(escalation.status, describeRun(escalation)).toBe(0)

    const done = receipt<{
      lifecycle?: { action: string; outcome?: string }
      mutation?: { requestId: string }
    }>(
      orca(workerHandle, [
        'orchestration',
        'send',
        '--from',
        workerHandle,
        '--dispatch-capability',
        capability,
        '--type',
        'worker_done',
        '--subject',
        'Guide contract complete',
        '--body',
        'Ran the guide sequence. Every receipt matched. Nothing remains.',
        '--task-id',
        taskId,
        '--dispatch-id',
        dispatchId,
        '--outcome',
        'succeeded',
        '--json'
      ])
    )
    expect(done.lifecycle?.action).toMatch(/^(completed|settled)$/)

    const settledDelivery = receipt<{
      deliveryId: string | null
      messages: { id: string; type?: string }[]
    }>(
      orca(restoredCoordinator, [
        'orchestration',
        'check',
        '--ack',
        firstDelivery.deliveryId as string,
        '--wait',
        '--types',
        'worker_done,escalation,question',
        '--timeout-ms',
        '60000',
        '--json'
      ])
    )
    expect(settledDelivery.messages.map((message) => message.type)).toContain('worker_done')

    // ── Inspection and cleanup verbs ─────────────────────────────────────────
    const workers = receipt<{ workers: { dispatchId: string }[] }>(
      orca(restoredCoordinator, [
        'orchestration',
        'worker-list',
        '--run',
        runId,
        '--include-remote',
        '--json'
      ])
    )
    expect(workers.workers.map((entry) => entry.dispatchId)).toContain(dispatchId)
    const workerShow = receipt<{ dispatchId?: string; dispatch?: { id: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'worker-show',
        '--dispatch',
        dispatchId,
        '--json'
      ])
    )
    expect(workerShow.dispatchId ?? workerShow.dispatch?.id).toBe(dispatchId)
    const workerRead = orca(restoredCoordinator, [
      'orchestration',
      'worker-read',
      '--dispatch',
      dispatchId,
      '--limit',
      '50',
      '--json'
    ])
    expect(workerRead.status, describeRun(workerRead)).toBe(0)

    const retained = receipt<{ state: string }>(
      orca(restoredCoordinator, [
        'orchestration',
        'worker-retain',
        '--dispatch',
        dispatchId,
        '--json'
      ])
    )
    expect(retained.state).toBe('retained')
    const released = receipt<{ state: string }>(
      orca(restoredCoordinator, [
        'orchestration',
        'worker-release',
        '--dispatch',
        dispatchId,
        '--json'
      ])
    )
    expect(['released', 'retained']).toContain(released.state)

    // ── Low-level topology and mutation recovery ─────────────────────────────
    const injectTask = receipt<{ task: { id: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'task-create',
        '--spec',
        'Guide contract: the low-level dispatch Task',
        '--json'
      ])
    )
    const injectTarget = await createAgentTerminal(client, worktreeId, agent.command)
    const injected = receipt<{ dispatchId?: string; dispatch?: { id: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'dispatch',
        '--task',
        injectTask.task.id,
        '--to',
        injectTarget,
        '--inject',
        '--json'
      ])
    )
    const injectedDispatchId = injected.dispatchId ?? injected.dispatch?.id
    expect(injectedDispatchId).toBeTruthy()
    await expect
      .poll(() => agent.readStdin(injectTarget), {
        timeout: 60_000,
        message: 'dispatch --inject never reached the target agent'
      })
      .toContain(injectTask.task.id)

    const gate = receipt<{ gate: { id: string; status: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'gate-create',
        '--task',
        firstTask.task.id,
        '--question',
        'Guide contract: which branch?',
        '--options',
        JSON.stringify(['merge', 'revert']),
        '--json'
      ])
    )
    const gates = receipt<{ gates: { id: string }[] }>(
      orca(restoredCoordinator, [
        'orchestration',
        'gate-list',
        '--task',
        firstTask.task.id,
        '--json'
      ])
    )
    expect(gates.gates.map((entry) => entry.id)).toContain(gate.gate.id)
    const resolvedGate = receipt<{ gate: { id: string; status: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'gate-resolve',
        '--id',
        gate.gate.id,
        '--resolution',
        'merge',
        '--json'
      ])
    )
    expect(resolvedGate.gate.status).toBe('resolved')

    // The recovery question after a lost response, asked about a mutation that really landed.
    const settledRequestId = done.mutation?.requestId as string
    expect(settledRequestId, JSON.stringify(done)).toBeTruthy()
    const requestShow = receipt<{ requestId: string; state: string; interpretation: string }>(
      orca(restoredCoordinator, [
        'orchestration',
        'request-show',
        '--request',
        settledRequestId,
        '--json'
      ])
    )
    expect(requestShow.requestId).toBe(settledRequestId)
    expect(requestShow.state).toBe('completed')
    expect(requestShow.interpretation.length).toBeGreaterThan(0)

    const runScopedCheck = receipt<{ messages: unknown[] }>(
      orca(restoredCoordinator, ['orchestration', 'check', '--run', runId, '--json'])
    )
    expect(Array.isArray(runScopedCheck.messages)).toBe(true)

    // ── Planned fan-out: start a named Task, then stop that exact worker ─────
    const plannedTask = receipt<{ task: { id: string } }>(
      orca(restoredCoordinator, [
        'orchestration',
        'task-create',
        '--spec',
        'Guide contract: the planned-fan-out Task',
        '--json'
      ])
    )
    const secondStart = receipt<{
      taskId: string
      dispatchId: string
      effects: { kind: string; role?: string; id?: string }[]
    }>(
      orca(restoredCoordinator, [
        'orchestration',
        'worker-start',
        '--task',
        plannedTask.task.id,
        '--worktree',
        'current',
        '--agent',
        'codex',
        '--json'
      ])
    )
    expect(secondStart.taskId).toBe(plannedTask.task.id)
    const secondWorker = secondStart.effects.find(
      (effect) => effect.kind === 'terminal' && effect.role === 'agent'
    )?.id as string
    expect(secondWorker, JSON.stringify(secondStart)).toBeTruthy()

    const stopped = receipt<{ state: string; processAction: string }>(
      orca(restoredCoordinator, [
        'orchestration',
        'worker-stop',
        '--dispatch',
        secondStart.dispatchId,
        '--json'
      ])
    )
    expect(stopped.state).not.toBe('stop_unknown')
    // worker-stop closes the exact supervised terminal it owns, and only that one.
    await expect
      .poll(
        async () => {
          const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
          return listed.result.terminals.map((entry) => entry.handle)
        },
        { timeout: 60_000, message: 'worker-stop never closed the stopped worker terminal' }
      )
      .not.toContain(secondWorker)
    const survivors = await client.call<RuntimeTerminalListResult>('terminal.list')
    expect(survivors.result.terminals.map((entry) => entry.handle)).toContain(injectTarget)

    // ── The drift gate ───────────────────────────────────────────────────────
    expect(findStaleExcuses(process.cwd())).toEqual([])
    expect(findGuideCoverageGaps(ledger.executedPairs(), process.cwd())).toEqual({
      unexecuted: [],
      undocumented: []
    })
  } finally {
    if (firstApp) {
      await session.close(firstApp)
    }
    if (secondApp) {
      await session.close(secondApp)
    }
    await session.dispose()
  }
})
