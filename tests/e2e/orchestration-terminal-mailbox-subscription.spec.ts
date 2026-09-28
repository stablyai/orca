import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import {
  CODEX_IDLE_TITLE,
  CODEX_WORKING_TITLE,
  CURSOR_IDLE_TITLE,
  createMailPaneAgent,
  type MailPaneAgent
} from './helpers/orchestration-mail-pane-agent'
import { mailDisposition, readMailRow } from './helpers/orchestration-mail-store'

const POINTER_COMMAND = 'orca-dev orchestration inbox'
const DELIVERY_TIMEOUT_MS = 20_000
const NO_DELIVERY_SETTLE_MS = 3_000

type AgentPane = {
  handle: string
  agent: MailPaneAgent
  ptyId: string
}

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

async function setUpRuntime(page: Page, electronApp: ElectronApplication) {
  await waitForSessionReady(page)
  const worktreeId = await waitForActiveWorktree(page)
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  const userDataDir = await readUserDataDir(electronApp)
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        return listed.result.worktrees.some((worktree) => worktree.id === worktreeId)
      },
      { timeout: 60_000, message: 'runtime never registered the active worktree' }
    )
    .toBe(true)
  return { client, userDataDir, worktreeId }
}

async function launchAttestedAgentPane(
  page: Page,
  client: RuntimeClient,
  agent: MailPaneAgent
): Promise<AgentPane> {
  await page.evaluate(
    async ({ agentCommand }) => {
      await window.__store?.getState().updateSettings({
        agentCmdOverrides: { codex: agentCommand },
        disabledTuiAgents: []
      })
    },
    { agentCommand: agent.launchCommand }
  )
  await page.getByRole('button', { name: /^(New tab|새 탭)$/i }).click({ force: true })
  const launchOption = page.getByRole('menuitem', { name: /^Codex(?:\s|$)/i }).first()
  await expect(launchOption).toBeVisible({ timeout: 15_000 })
  await launchOption.click({ force: true })
  await expect
    .poll(() => agent.readLedger().find((entry) => entry.event === 'start'), {
      timeout: 60_000,
      message: 'attested agent never started'
    })
    .toMatchObject({ hasLaunchToken: true })
  const ptyId = await waitForActivePanePtyId(page)
  const { paneKey } = await waitForActivePaneHookDescriptor(page)
  const resolved = await client.call<{ terminal: { handle: string } }>('terminal.resolvePane', {
    paneKey
  })
  return { handle: resolved.result.terminal.handle, agent, ptyId }
}

async function launchBackgroundCursorPane(
  page: Page,
  client: RuntimeClient,
  parentWorktreeId: string,
  agent: MailPaneAgent
): Promise<{ pane: AgentPane; worktreeId: string }> {
  await page.evaluate(async (agentCommand) => {
    await window.__store?.getState().updateSettings({
      agentCmdOverrides: { cursor: agentCommand },
      disabledTuiAgents: []
    })
  }, agent.launchCommand)
  const parent = await client.call<{ worktree: { repoId: string } }>('worktree.show', {
    worktree: `id:${parentWorktreeId}`
  })
  const created = await client.call<{
    worktree: { id: string }
    agentTerminalHandle?: string
  }>('worktree.create', {
    repo: `id:${parent.result.worktree.repoId}`,
    name: `cursor-mail-${randomUUID()}`,
    noParent: true,
    activate: false,
    setupDecision: 'skip',
    startupAgent: 'cursor',
    startupPrompt: ''
  })
  const handle = created.result.agentTerminalHandle
  if (!handle) {
    throw new Error('Cursor worktree did not publish its startup terminal handle')
  }
  await expect
    .poll(() => agent.readLedger().find((entry) => entry.event === 'start'), {
      timeout: 60_000,
      message: 'attested Cursor agent never started'
    })
    .toMatchObject({ hasLaunchToken: true, terminalHandle: handle })
  let ptyId: string | null = null
  await expect
    .poll(
      async () => {
        const listed = await client.call<RuntimeTerminalListResult>('terminal.list')
        ptyId = listed.result.terminals.find((entry) => entry.handle === handle)?.ptyId ?? null
        return ptyId
      },
      { timeout: 30_000, message: 'Cursor startup terminal never became live' }
    )
    .not.toBeNull()
  return {
    pane: { handle, agent, ptyId: ptyId! },
    worktreeId: created.result.worktree.id
  }
}

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

async function driveToLiveIdle(client: RuntimeClient, pane: AgentPane): Promise<void> {
  pane.agent.setTitle(CODEX_WORKING_TITLE)
  await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
  pane.agent.setTitle(CODEX_IDLE_TITLE)
  await waitForObservedTitle(client, pane.handle, CODEX_IDLE_TITLE)
}

async function sendMail(
  client: RuntimeClient,
  to: string,
  subject: string,
  body = 'e2e body'
): Promise<string> {
  const sent = await client.call<{ message: { id: string } }>('orchestration.send', {
    to,
    from: 'e2e-sender',
    subject,
    body,
    type: 'status'
  })
  return sent.result.message.id
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1
}

test('receiver CLI subscribes a live bare terminal and keeps pointed mail unread', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const { client, userDataDir } = await setUpRuntime(orcaPage, electronApp)
  const agent = createMailPaneAgent({
    cliEntry: path.join(process.cwd(), 'out', 'cli', 'index.js')
  })
  const pane = await launchAttestedAgentPane(orcaPage, client, agent)
  await driveToLiveIdle(client, pane)

  const mutationRequestId = randomUUID()
  agent.runCli('subscribe', [
    'orchestration',
    'subscribe',
    '--retry-request',
    mutationRequestId,
    '--json'
  ])
  await expect
    .poll(() => agent.readCliResult('subscribe'), {
      timeout: 30_000,
      message: 'the receiver-side CLI never completed subscription'
    })
    .toBeDefined()
  const subscribed = agent.readCliResult('subscribe')!
  expect(subscribed.status, JSON.stringify(subscribed)).toBe(0)
  expect(JSON.parse(subscribed.stdout ?? '')).toMatchObject({
    ok: true,
    result: {
      subscribed: true,
      state: 'active',
      mutation: { requestId: mutationRequestId, replayed: false }
    }
  })

  const body = 'E2E_BODY_MUST_NOT_ENTER_THE_PTY'
  const firstMessageId = await sendMail(client, pane.handle, 'Subscribed bare terminal', body)
  await expect
    .poll(() => agent.readStdin(), {
      timeout: DELIVERY_TIMEOUT_MS,
      message: 'mail pointer never reached the subscribed agent process'
    })
    .toContain(POINTER_COMMAND)
  await expect
    .poll(() => agent.readStdin().includes('\r'), {
      timeout: DELIVERY_TIMEOUT_MS,
      message: 'recognized idle Codex pane never received synthesized Enter'
    })
    .toBe(true)
  expect(agent.readStdin()).not.toContain(body)
  await expect
    .poll(() => readMailRow(userDataDir, firstMessageId), { timeout: DELIVERY_TIMEOUT_MS })
    .toMatchObject({ read: 0, to_handle: pane.handle })
  expect(mailDisposition(readMailRow(userDataDir, firstMessageId))).toBe('pushed')

  agent.setTitle(CODEX_WORKING_TITLE)
  await waitForObservedTitle(client, pane.handle, CODEX_WORKING_TITLE)
  const pointersBeforeWorking = countOccurrences(agent.readStdin(), POINTER_COMMAND)
  const workingMessageId = await sendMail(client, pane.handle, 'Hold while working')
  await orcaPage.waitForTimeout(NO_DELIVERY_SETTLE_MS)
  expect(countOccurrences(agent.readStdin(), POINTER_COMMAND)).toBe(pointersBeforeWorking)
  expect(mailDisposition(readMailRow(userDataDir, workingMessageId))).toBe('pending')

  agent.setTitle(CODEX_IDLE_TITLE)
  await waitForObservedTitle(client, pane.handle, CODEX_IDLE_TITLE)
  await expect
    .poll(() => countOccurrences(agent.readStdin(), POINTER_COMMAND), {
      timeout: DELIVERY_TIMEOUT_MS
    })
    .toBeGreaterThan(pointersBeforeWorking)
  await expect
    .poll(() => mailDisposition(readMailRow(userDataDir, workingMessageId)), {
      timeout: DELIVERY_TIMEOUT_MS
    })
    .toBe('pushed')

  agent.runCli('unsubscribe', [
    'orchestration',
    'unsubscribe',
    '--retry-request',
    randomUUID(),
    '--json'
  ])
  await expect
    .poll(() => agent.readCliResult('unsubscribe'), { timeout: 30_000 })
    .toMatchObject({ status: 0 })
  expect(JSON.parse(agent.readCliResult('unsubscribe')?.stdout ?? '')).toMatchObject({
    ok: true,
    result: { subscribed: false, state: 'unsubscribed' }
  })

  agent.runCli('subscribe-replay', [
    'orchestration',
    'subscribe',
    '--retry-request',
    mutationRequestId,
    '--json'
  ])
  await expect
    .poll(() => agent.readCliResult('subscribe-replay'), { timeout: 30_000 })
    .toMatchObject({ status: 0 })
  expect(JSON.parse(agent.readCliResult('subscribe-replay')?.stdout ?? '')).toMatchObject({
    ok: true,
    result: {
      subscribed: false,
      state: 'unsubscribed',
      mutation: { requestId: mutationRequestId, replayed: true },
      historicalReplay: { subscribed: true }
    }
  })

  const pointersBefore = countOccurrences(agent.readStdin(), POINTER_COMMAND)
  const secondMessageId = await sendMail(client, pane.handle, 'Unsubscribed bare terminal')
  await orcaPage.waitForTimeout(NO_DELIVERY_SETTLE_MS)
  expect(countOccurrences(agent.readStdin(), POINTER_COMMAND)).toBe(pointersBefore)
  expect(readMailRow(userDataDir, secondMessageId)).toMatchObject({
    read: 0,
    delivered_at: null,
    to_handle: pane.handle
  })
})

test('positive Cursor identity receives the pointer without synthesized Enter', async ({
  orcaPage,
  electronApp
}) => {
  test.setTimeout(180_000)
  const { client, userDataDir, worktreeId } = await setUpRuntime(orcaPage, electronApp)
  const agent = createMailPaneAgent({
    cliEntry: path.join(process.cwd(), 'out', 'cli', 'index.js')
  })
  let createdWorktreeId: string | null = null
  try {
    const launched = await launchBackgroundCursorPane(orcaPage, client, worktreeId, agent)
    const pane = launched.pane
    createdWorktreeId = launched.worktreeId
    agent.setTitle(CURSOR_IDLE_TITLE)
    await waitForObservedTitle(client, pane.handle, CURSOR_IDLE_TITLE)

    agent.runCli('subscribe-cursor', ['orchestration', 'subscribe', '--json'])
    await expect
      .poll(() => agent.readCliResult('subscribe-cursor'), { timeout: 30_000 })
      .toMatchObject({ status: 0 })
    expect(JSON.parse(agent.readCliResult('subscribe-cursor')?.stdout ?? '')).toMatchObject({
      ok: true,
      result: { subscribed: true, state: 'active' }
    })

    const messageId = await sendMail(client, pane.handle, 'Cursor stays manual')
    await expect
      .poll(() => agent.readStdin(), { timeout: DELIVERY_TIMEOUT_MS })
      .toContain(POINTER_COMMAND)
    await orcaPage.waitForTimeout(1_000)
    expect(agent.readStdin()).not.toContain('\r')
    expect(readMailRow(userDataDir, messageId)).toMatchObject({
      read: 0,
      to_handle: pane.handle
    })
    expect(mailDisposition(readMailRow(userDataDir, messageId))).toBe('pushed')
  } finally {
    if (createdWorktreeId) {
      await client.call('worktree.rm', {
        worktree: `id:${createdWorktreeId}`,
        force: true,
        allowUnverifiedPtyStop: true,
        runHooks: false
      })
    }
  }
})
