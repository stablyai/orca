// #12536: push mail to an already-idle unsupervised agent without waiting for a busy→idle edge.
// Real PTY stdin ledgers prove pointer/Enter delivery; runtime units cover microtask, respawn and waiter-reservation races.
import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible,
  getActiveTabId
} from './helpers/store'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { RuntimeClient, type RuntimeRpcSuccess } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import {
  CODEX_IDLE_TITLE,
  CODEX_WORKING_TITLE,
  CURSOR_IDLE_TITLE,
  createMailPaneAgent,
  type MailPaneAgent
} from './helpers/orchestration-mail-pane-agent'
import {
  insertDirectRunMail,
  mailDisposition,
  readMailbox,
  readMailRow
} from './helpers/orchestration-mail-store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'
import { parkHiddenTabBehindDecoy } from './helpers/terminal-hidden-parking'

const POINTER_COMMAND = 'orca-dev orchestration check'

// Allow microtask/liveness deferral and the delayed Enter submission.
const DELIVERY_TIMEOUT_MS = 20_000
// Wait through the full delivery chain before concluding a gate refused.
const NO_DELIVERY_SETTLE_MS = 3_000

type AgentPane = {
  handle: string
  agent: MailPaneAgent
  ptyId: string
}

type MailFixture = {
  client: RuntimeClient
  userDataDir: string
  worktreeId: string
  openAgentPane: (options?: {
    titleOnStdin?: { needle: string; title: string }
  }) => Promise<AgentPane>
}

type WaitingCheck = RuntimeRpcSuccess<{
  deliveryId: string | null
  messages: { subject: string }[]
}>

// Retry startup context replacement, matching installTerminalPtyWriteSpy.
async function readUserDataDir(electronApp: ElectronApplication): Promise<string> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await electronApp.evaluate(({ app }) => app.getPath('userData'))
    } catch (error) {
      const transient =
        error instanceof Error && error.message.includes('Execution context was destroyed')
      if (!transient || attempt >= 5) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

async function setUpMailFixture(
  orcaPage: Page,
  electronApp: ElectronApplication
): Promise<MailFixture> {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)

  const userDataDir = await readUserDataDir(electronApp)
  const client = new RuntimeClient(userDataDir, 30_000, null, null)

  // Wait for runtime registration: renderer activation alone still leaves terminal.create returning selector_not_found.
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        return listed.result.worktrees.some((worktree) => worktree.id === worktreeId)
      },
      { timeout: 60_000, message: 'runtime never registered the active worktree' }
    )
    .toBe(true)

  const openAgentPane = async (options?: {
    titleOnStdin?: { needle: string; title: string }
  }): Promise<AgentPane> => {
    // Reuse the mounted leaf that push delivery resolves its target through.
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    const resolved = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
      paneKey
    })
    const handle = resolved.result.terminal.handle

    // Prove prompt echo first or dropped startup keystrokes can prevent the fixture agent from launching.
    await waitForPtyShellEcho(orcaPage, ptyId, 60_000)
    const agent = createMailPaneAgent(options)
    await execInTerminal(orcaPage, ptyId, agent.launchCommand)
    await expect
      .poll(() => agent.hasStarted(), { timeout: 60_000, message: 'agent never started' })
      .toBe(true)
    return { handle, agent, ptyId }
  }

  return { client, userDataDir, worktreeId, openAgentPane }
}

/** Wait until the runtime has observed `title` as a LIVE frame from the pane. */
async function waitForObservedTitle(
  client: RuntimeClient,
  handle: string,
  title: string
): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
        return listed.result.terminals.find((entry) => entry.handle === handle)?.title ?? null
      },
      { timeout: 30_000, message: `runtime never observed the title ${title}` }
    )
    .toBe(title)
}

/** Put the pane in the state #12536 is about: idle, observed live, no transition pending. */
async function driveToLiveIdle(client: RuntimeClient, pane: AgentPane): Promise<void> {
  pane.agent.setTitle(CODEX_WORKING_TITLE)
  await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
  pane.agent.setTitle(CODEX_IDLE_TITLE)
  await waitForObservedTitle(client, pane.handle, CODEX_IDLE_TITLE)
}

async function sendMail(
  client: RuntimeClient,
  to: string,
  overrides: { subject: string; type?: string; body?: string }
): Promise<string> {
  const sent = await client.call<{ message: { id: string } }>('orchestration.send', {
    to,
    from: 'e2e-sender',
    subject: overrides.subject,
    body: overrides.body ?? 'e2e body',
    type: overrides.type ?? 'status'
  })
  return sent.result.message.id
}

async function createRunMailbox(
  client: RuntimeClient,
  pane: AgentPane,
  objective: string
): Promise<string> {
  const created = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
    objective,
    from: pane.handle
  })
  return `run:${created.result.run.id}`
}

async function expectPointed(pane: AgentPane, count = 1): Promise<void> {
  await expect
    .poll(() => pane.agent.readStdin(), {
      timeout: DELIVERY_TIMEOUT_MS,
      message: 'mail pointer never reached the agent process'
    })
    .toContain(POINTER_COMMAND)
  const noun = count === 1 ? 'message' : 'messages'
  expect(pane.agent.readStdin()).toContain(`${count} orchestration ${noun}`)
}

// The pointer contains only LF; any CR proves the separate delayed Enter arrived, regardless of PTY chunking.
async function expectSubmitted(pane: AgentPane): Promise<void> {
  await expect
    .poll(() => pane.agent.readStdin().includes('\r'), {
      timeout: DELIVERY_TIMEOUT_MS,
      message: 'orchestration never synthesized Enter'
    })
    .toBe(true)
}

/** Inverse of expectSubmitted, for the panes whose submit stays user-owned. */
function expectNotSubmitted(pane: AgentPane): void {
  expect(pane.agent.readStdin()).not.toContain('\r')
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('activateTerminalTab: window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTabType('terminal', state.activeWorktreeId)
    state.setActiveTab(targetTabId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page), { timeout: 5_000 }).toBe(tabId)
}

// Wait the full window: polling for pending could pass before delivery ever runs.
async function expectStaysPending(
  page: Page,
  userDataDir: string,
  pane: AgentPane,
  messageId: string
): Promise<void> {
  // The row must exist first, or "pending" could just mean the send never landed.
  expect(readMailRow(userDataDir, messageId)).toBeDefined()
  await page.waitForTimeout(NO_DELIVERY_SETTLE_MS)
  expect(mailDisposition(readMailRow(userDataDir, messageId))).toBe('pending')
  expect(pane.agent.readStdin()).not.toContain(POINTER_COMMAND)
}

test.describe('orchestration push-on-idle mail delivery', () => {
  test('delivers mail that arrives while the agent is already idle', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    await driveToLiveIdle(client, pane)
    const mailbox = await createRunMailbox(client, pane, 'Already idle delivery')

    // Send without another busy→idle edge, which stranded mail before #12536.
    const subject = 'Already idle delivery'
    const messageId = await sendMail(client, mailbox, { subject })

    await expectPointed(pane)
    await expectSubmitted(pane)
    await expect
      .poll(() => mailDisposition(readMailRow(userDataDir, messageId)), {
        timeout: DELIVERY_TIMEOUT_MS
      })
      .toBe('pushed')
  })

  test('holds mail while the agent is working and releases it on the idle frame', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    pane.agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
    const mailbox = await createRunMailbox(client, pane, 'Held while working')

    const subject = 'Held while working'
    const messageId = await sendMail(client, mailbox, { subject })
    await expectStaysPending(orcaPage, userDataDir, pane, messageId)

    // Release the working gate to prove the earlier silence was not disconnected delivery wiring.
    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await expectPointed(pane)
    await expect
      .poll(() => mailDisposition(readMailRow(userDataDir, messageId)), {
        timeout: DELIVERY_TIMEOUT_MS
      })
      .toBe('pushed')
  })

  // This covers null→idle; orchestration-idle-mail-restore.spec.ts covers restart without a new status transition.
  test('delivers mail queued before a fresh agent has reported any status', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    const mailbox = await createRunMailbox(client, pane, 'First live idle frame')

    // No title models a resumed agent before its first prompt.
    const subject = 'First live idle frame'
    const messageId = await sendMail(client, mailbox, { subject })
    await expectStaysPending(orcaPage, userDataDir, pane, messageId)

    // Its first live idle observation must trigger delivery without a prior working status.
    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await expectPointed(pane)
    await expectSubmitted(pane)
  })

  // #19542: keep direct mail durable under the unbound Run without injecting an unsafe check pointer.
  test('keeps unbound direct mail durable without pointing to an unsafe check', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    await driveToLiveIdle(client, pane)

    // Unbound terminals still need durable direct mail; reopen must not classify it as pre-Runs state.
    const stdinBeforeScan = pane.agent.readStdin()
    const messageId = await sendMail(client, pane.handle, { subject: 'Unbound direct mail' })
    pane.agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_IDLE_TITLE)

    await orcaPage.waitForTimeout(NO_DELIVERY_SETTLE_MS)
    expect(readMailRow(userDataDir, messageId)).toMatchObject({
      to_handle: pane.handle,
      run_id: 'run_unbound',
      read: 0,
      delivered_at: null
    })
    expect(pane.agent.readStdin()).toBe(stdinBeforeScan)
  })

  test('leaves the mail to a live waiter instead of pushing it into the pane', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    await driveToLiveIdle(client, pane)
    const mailbox = await createRunMailbox(client, pane, 'Live waiter')

    // A supervised waiter consumes read while push stamps delivered_at; either alone leaves duplicate delivery possible.
    // Two waits model a forgotten listener plus its replacement.
    const waitForMail = (): Promise<WaitingCheck> =>
      client.call<WaitingCheck['result']>('orchestration.check', {
        terminal: pane.handle,
        wait: true,
        timeoutMs: 30_000
      })
    const waiters = [waitForMail(), waitForMail()]
    // ast-grep-ignore: test-no-real-time-wait -- the runtime exposes no signal that a wait registered
    await orcaPage.waitForTimeout(NO_DELIVERY_SETTLE_MS)

    const subject = 'Waiter claims it'
    const messageId = await sendMail(client, mailbox, { subject })

    const [first, second] = await Promise.all(waiters)
    expect(first.result.messages.map((message) => message.subject)).toContain(subject)
    expect(first.result.deliveryId).toEqual(expect.any(String))
    expect(second.result.deliveryId).toBe(first.result.deliveryId)
    expect(pane.agent.readStdin()).not.toContain(POINTER_COMMAND)
    expect(mailDisposition(readMailRow(userDataDir, messageId))).toBe('pending')
    for (const waiter of [first, second]) {
      await client.call('orchestration.check', {
        terminal: pane.handle,
        ack: waiter.result.deliveryId
      })
    }
    expect(mailDisposition(readMailRow(userDataDir, messageId))).toBe('pulled')
  })

  test('pushes to the pane when the only waiter filters this message type out', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    await driveToLiveIdle(client, pane)
    const mailbox = await createRunMailbox(client, pane, 'Filtered waiter')

    // worker_done waiters cannot consume status mail and must not suppress its push.
    const waiting = client
      .call('orchestration.check', {
        terminal: pane.handle,
        types: 'worker_done',
        wait: true,
        timeoutMs: 8_000
      })
      .catch(() => undefined)
    await orcaPage.waitForTimeout(1_000)

    const subject = 'Filtered waiter'
    const messageId = await sendMail(client, mailbox, { subject, type: 'status' })

    await expectPointed(pane)
    await expect
      .poll(() => mailDisposition(readMailRow(userDataDir, messageId)), {
        timeout: DELIVERY_TIMEOUT_MS
      })
      .toBe('pushed')
    await waiting
  })

  test('worker completion points and wakes its idle Run coordinator without consuming mail', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    await driveToLiveIdle(client, pane)

    const run = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Verify worker completion pointer delivery',
      from: pane.handle
    })
    const task = await client.call<{ task: { id: string } }>('orchestration.taskCreate', {
      spec: 'Report one P3 finding',
      run: run.result.run.id,
      callerTerminalHandle: pane.handle
    })
    const dispatched = await client.call<{ dispatch: { id: string } }>('orchestration.dispatch', {
      task: task.result.task.id,
      run: run.result.run.id,
      from: pane.handle,
      to: pane.handle
    })
    const body = 'full private review finding must remain in SQLite'
    const payload = JSON.stringify({
      taskId: task.result.task.id,
      dispatchId: dispatched.result.dispatch.id,
      outcome: 'succeeded'
    })
    const sendParams = {
      from: pane.handle,
      to: pane.handle,
      subject: 'review: one P3 finding',
      body,
      type: 'worker_done',
      payload
    }
    const orchestrationRequestId = randomUUID()
    const sent = await client.call<{ message: { id: string; to_handle: string } }>(
      'orchestration.send',
      sendParams,
      { orchestrationRequestId }
    )
    const runAddress = `run:${run.result.run.id}`
    expect(sent.result.message.to_handle).toBe(runAddress)

    await expectPointed(pane)
    await expectSubmitted(pane)
    expect(pane.agent.readStdin()).not.toContain(body)
    const pointedRow = readMailRow(userDataDir, sent.result.message.id)
    expect(pointedRow).toMatchObject({
      to_handle: runAddress,
      read: 0,
      delivered_at: expect.any(String)
    })

    const stdinAfterFirstPointer = pane.agent.readStdin()
    const duplicate = await client.call<{ message: { id: string } }>(
      'orchestration.send',
      sendParams,
      { orchestrationRequestId }
    )
    pane.agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_IDLE_TITLE)
    await orcaPage.waitForTimeout(NO_DELIVERY_SETTLE_MS)
    expect(pane.agent.readStdin()).toBe(stdinAfterFirstPointer)
    expect(duplicate.result.message.id).toBe(sent.result.message.id)
    expect(readMailbox(userDataDir, runAddress).filter((row) => row.read === 0)).toEqual([
      expect.objectContaining({ id: sent.result.message.id })
    ])

    const checked = await client.call<{ messages: { id: string; body: string }[] }>(
      'orchestration.check',
      { terminal: pane.handle, run: run.result.run.id }
    )
    expect(checked.result.messages).toEqual([
      expect.objectContaining({ id: sent.result.message.id, body })
    ])
  })

  // STA-11980: an unacked batch defers the nudge for newer mail instead of dropping it.
  test('points newer mail once behind an unacked Delivery, after a turn that started in the Enter delay', async ({
    orcaPage,
    electronApp
  }) => {
    // Agent launch, two idle edges and two settle windows.
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const reminder = 'which you have not acknowledged'
    const pane = await openAgentPane({
      titleOnStdin: { needle: reminder, title: CODEX_WORKING_TITLE }
    })
    pane.agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
    const mailbox = await createRunMailbox(client, pane, 'Unacked Delivery')
    await sendMail(client, mailbox, { subject: 'Held batch' })
    const held = await client.call<WaitingCheck['result']>('orchestration.check', {
      terminal: pane.handle
    })
    const heldId = held.result.deliveryId!
    const newerId = await sendMail(client, mailbox, { subject: 'Newer mail' })

    // The fake starts working as the reminder lands, inside the Enter delay.
    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await expect
      .poll(() => countOccurrences(pane.agent.readStdin(), reminder), {
        timeout: DELIVERY_TIMEOUT_MS,
        message: 'held-batch reminder never reached the agent'
      })
      .toBe(1)
    expect(pane.agent.readStdin()).toContain(`--ack ${heldId}`)
    await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
    // ast-grep-ignore: test-no-real-time-wait -- outlast the Enter delay; a withheld Enter has no signal
    await orcaPage.waitForTimeout(1_000)
    expect(countOccurrences(pane.agent.readStdin(), '\r')).toBe(0)

    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await expectSubmitted(pane)
    await expect
      .poll(() => mailDisposition(readMailRow(userDataDir, newerId)), {
        timeout: DELIVERY_TIMEOUT_MS
      })
      .toBe('pushed')

    // A later idle edge with nothing newer stays quiet.
    await driveToLiveIdle(client, pane)
    // ast-grep-ignore: test-no-real-time-wait -- absence of a second pointer needs the delivery chain's window
    await orcaPage.waitForTimeout(NO_DELIVERY_SETTLE_MS)
    expect(countOccurrences(pane.agent.readStdin(), reminder)).toBe(1)
    expect(countOccurrences(pane.agent.readStdin(), '\r')).toBe(1)

    const acked = await client.call<WaitingCheck['result']>('orchestration.check', {
      terminal: pane.handle,
      ack: heldId
    })
    expect(acked.result.messages.map((message) => message.subject)).toEqual(['Newer mail'])
  })

  test('never points direct Run A mail after the pane binds Run B', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    pane.agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)

    const runA = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Original mailbox owner',
      from: pane.handle
    })
    const runB = await client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Current pane binding',
      from: pane.handle
    })
    const messageId = insertDirectRunMail(userDataDir, {
      runId: runA.result.run.id,
      toHandle: pane.handle,
      subject: 'Run A direct completion'
    })
    expect(readMailRow(userDataDir, messageId)).toMatchObject({
      run_id: runA.result.run.id,
      delivery_contract: 'current_delivery',
      to_handle: `run:${runA.result.run.id}`,
      read: 0,
      delivered_at: null
    })

    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_IDLE_TITLE)
    await expect
      .poll(() => readMailRow(userDataDir, messageId)?.to_handle, {
        timeout: DELIVERY_TIMEOUT_MS,
        message: 'stale direct mail never reached its authoritative Run mailbox'
      })
      .toBe(`run:${runA.result.run.id}`)

    const checked = await client.call<{
      runId: string
      deliveryId: string | null
      messages: unknown[]
      count: number
    }>('orchestration.check', { terminal: pane.handle })
    expect(checked.result).toMatchObject({
      runId: runB.result.run.id,
      deliveryId: null,
      messages: [],
      count: 0
    })
    expect(pane.agent.readStdin()).not.toContain(POINTER_COMMAND)
    expectNotSubmitted(pane)
    expect(readMailRow(userDataDir, messageId)).toMatchObject({
      to_handle: `run:${runA.result.run.id}`,
      read: 0,
      delivered_at: null
    })
  })

  test('writes and submits the pointer for the active coordinator pane', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    await driveToLiveIdle(client, pane)
    const mailbox = await createRunMailbox(client, pane, 'Coordinator pointer submit')

    const subject = 'Coordinator pointer submit'
    await sendMail(client, mailbox, { subject })

    await expectPointed(pane)
    await expectSubmitted(pane)
  })

  test('writes and submits the pointer for a Cursor agent pane', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, openAgentPane } = await setUpMailFixture(orcaPage, electronApp)
    const pane = await openAgentPane()
    pane.agent.setTitle(CURSOR_IDLE_TITLE)
    await waitForObservedTitle(client, pane.handle, CURSOR_IDLE_TITLE)
    const mailbox = await createRunMailbox(client, pane, 'Cursor pointer submit')

    const subject = 'Cursor pointer submit'
    await sendMail(client, mailbox, { subject })

    await expectPointed(pane)
    await expectSubmitted(pane)
  })
})

test.describe('orchestration delivery to a cold-parked agent', () => {
  const parkingDelayMs = 500

  test.use({
    orcaAppExtraEnv: {
      ORCA_E2E_TERMINAL_PARKING_DELAY_MS: String(parkingDelayMs),
      // Allow CI’s title roundtrip to beat Enter; production’s 500ms heuristic is not a reliable test budget.
      ORCA_E2E_ORCHESTRATION_POINTER_ENTER_DELAY_MS: '5000'
    }
  })

  test('keeps one pointer and one idempotent prompt on the same parked PTY', async ({
    orcaPage,
    electronApp
  }, testInfo: TestInfo) => {
    test.setTimeout(180_000)
    const { client, userDataDir, worktreeId, openAgentPane } = await setUpMailFixture(
      orcaPage,
      electronApp
    )
    const pane = await openAgentPane()
    await driveToLiveIdle(client, pane)
    const mailbox = await createRunMailbox(client, pane, 'Cold parked delivery')
    const beforePark = await waitForPaneIdentitySnapshot(orcaPage, 1)
    expect(beforePark.panes[0]?.ptyId).toBe(pane.ptyId)
    const tabId = beforePark.tabId
    const agentPid = pane.agent.readLedger().find((entry) => entry.event === 'start')?.pid
    expect(agentPid).toEqual(expect.any(Number))

    const parkDetectedAfterMs = await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
      parkDelayMs: parkingDelayMs
    })
    expect(await getActiveTabId(orcaPage)).not.toBe(tabId)
    expect(await orcaPage.locator(`[data-terminal-tab-id=${JSON.stringify(tabId)}]`).count()).toBe(
      0
    )

    const mailSubject = `Cold parked pointer ${randomUUID()}`
    const messageId = await sendMail(client, mailbox, { subject: mailSubject })
    await expect
      .poll(
        () => ({
          pointers: countOccurrences(pane.agent.readStdin(), POINTER_COMMAND),
          enters: countOccurrences(pane.agent.readStdin(), '\r')
        }),
        {
          timeout: DELIVERY_TIMEOUT_MS,
          message: 'cold-parked mailbox delivery did not write one pointer and one Enter'
        }
      )
      .toEqual({ pointers: 1, enters: 1 })
    expect(mailDisposition(readMailRow(userDataDir, messageId))).toBe('pushed')
    const stdinAfterPointer = pane.agent.readStdin()

    const promptMarker = `ORCA_E2E_PARKED_PROMPT_${randomUUID()}`
    const promptRequestId = randomUUID()
    const promptParams = {
      terminal: pane.handle,
      text: promptMarker,
      enter: true,
      agentPrompt: true as const,
      client: { id: 'orca-e2e', type: 'desktop' as const }
    }
    const firstSend = await client.call<{
      send: { accepted: boolean; prompt?: { requestId: string; stages: string[] } }
      mutation: { requestId: string; replayed: boolean }
    }>('terminal.send', promptParams, { orchestrationRequestId: promptRequestId })
    expect(firstSend.result).toMatchObject({
      send: { accepted: true, prompt: { requestId: promptRequestId } },
      mutation: { requestId: promptRequestId, replayed: false }
    })
    await expect
      .poll(
        () => ({
          pointers: countOccurrences(pane.agent.readStdin(), POINTER_COMMAND),
          prompts: countOccurrences(pane.agent.readStdin(), promptMarker),
          enters: countOccurrences(pane.agent.readStdin(), '\r')
        }),
        { timeout: DELIVERY_TIMEOUT_MS, message: 'parked prompt did not reach the agent once' }
      )
      .toEqual({ pointers: 1, prompts: 1, enters: 2 })
    const stdinAfterFirstSend = pane.agent.readStdin()

    const replay = await client.call<{
      send: { accepted: boolean; prompt?: { requestId: string; stages: string[] } }
      mutation: { requestId: string; replayed: boolean }
    }>(
      'terminal.send',
      { ...promptParams, waitSubmitMs: 1_000 },
      { orchestrationRequestId: promptRequestId }
    )
    expect(replay.result).toMatchObject({
      send: { accepted: true, prompt: { requestId: promptRequestId } },
      mutation: { requestId: promptRequestId, replayed: true }
    })
    expect(pane.agent.readStdin()).toBe(stdinAfterFirstSend)

    await activateTerminalTab(orcaPage, tabId)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const afterReveal = await waitForPaneIdentitySnapshot(orcaPage, 1)
    expect(afterReveal.tabId).toBe(tabId)
    expect(afterReveal.panes[0]?.ptyId).toBe(pane.ptyId)
    await expect(
      orcaPage.locator(`[data-terminal-tab-id=${JSON.stringify(tabId)}] .xterm-screen`).first()
    ).toBeVisible()
    expect(new Set(pane.agent.readLedger().map((entry) => entry.pid))).toEqual(new Set([agentPid]))

    const evidence = {
      tabId,
      ptyBefore: pane.ptyId,
      ptyAfter: afterReveal.panes[0]?.ptyId,
      agentPid,
      parkDetectedAfterMs,
      pointerEnterCountAfterDelivery: countOccurrences(stdinAfterPointer, '\r'),
      pointerPayloadCount: countOccurrences(pane.agent.readStdin(), POINTER_COMMAND),
      promptPayloadCount: countOccurrences(pane.agent.readStdin(), promptMarker),
      enterCount: countOccurrences(pane.agent.readStdin(), '\r'),
      replayAddedStdin: pane.agent.readStdin().length - stdinAfterFirstSend.length,
      firstMutation: firstSend.result.mutation,
      replayMutation: replay.result.mutation
    }
    testInfo.annotations.push({
      type: 'cold-parked-orchestration-delivery',
      description: JSON.stringify(evidence)
    })
    const evidencePath = testInfo.outputPath('cold-parked-orchestration-delivery.json')
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
    await testInfo.attach('cold-parked-orchestration-delivery.json', {
      path: evidencePath,
      contentType: 'application/json'
    })
    const screenshotPath = testInfo.outputPath('cold-parked-agent-revealed.png')
    await orcaPage.screenshot({ path: screenshotPath, fullPage: true })
    await testInfo.attach('cold-parked-agent-revealed.png', {
      path: screenshotPath,
      contentType: 'image/png'
    })
  })

  test('does not submit a parked pointer after the agent starts working', async ({
    orcaPage,
    electronApp
  }) => {
    test.setTimeout(180_000)
    const { client, userDataDir, worktreeId, openAgentPane } = await setUpMailFixture(
      orcaPage,
      electronApp
    )
    const pane = await openAgentPane({
      titleOnStdin: { needle: POINTER_COMMAND, title: CODEX_WORKING_TITLE }
    })
    await driveToLiveIdle(client, pane)
    const mailbox = await createRunMailbox(client, pane, 'Cold parked working transition')
    const beforePark = await waitForPaneIdentitySnapshot(orcaPage, 1)
    const tabId = beforePark.tabId

    await parkHiddenTabBehindDecoy(orcaPage, worktreeId, tabId, {
      parkDelayMs: parkingDelayMs
    })
    const messageId = await sendMail(client, mailbox, {
      subject: `Cold parked working transition ${randomUUID()}`
    })

    await expect
      .poll(() => countOccurrences(pane.agent.readStdin(), POINTER_COMMAND), {
        timeout: DELIVERY_TIMEOUT_MS,
        message: 'cold-parked pointer never reached the agent'
      })
      .toBe(1)
    await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
    await orcaPage.waitForTimeout(1_000)
    expect(countOccurrences(pane.agent.readStdin(), '\r')).toBe(0)
    expect(mailDisposition(readMailRow(userDataDir, messageId))).toBe('pending')

    pane.agent.setTitle(CODEX_IDLE_TITLE)
    await waitForObservedTitle(client, pane.handle, CODEX_IDLE_TITLE)
    await expect
      .poll(
        () => ({
          pointers: countOccurrences(pane.agent.readStdin(), POINTER_COMMAND),
          enters: countOccurrences(pane.agent.readStdin(), '\r')
        }),
        {
          timeout: DELIVERY_TIMEOUT_MS,
          message: 'mail did not recover after the parked agent returned idle'
        }
      )
      .toEqual({ pointers: 1, enters: 1 })
    expect(mailDisposition(readMailRow(userDataDir, messageId))).toBe('pushed')
  })
})
