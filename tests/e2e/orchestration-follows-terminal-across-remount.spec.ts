// #24354: waits and mail address a terminal, not the pane a window shows for it, so opening
// a background worker's workspace (which remounts its pane) must not break either.
import { test, expect } from './helpers/orca-app'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import {
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type {
  RuntimeTerminalCreate,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary,
  RuntimeTerminalWait
} from '../../src/shared/runtime-types'
import {
  CODEX_IDLE_TITLE,
  CODEX_WORKING_TITLE,
  createMailPaneAgent,
  type MailPaneAgent
} from './helpers/orchestration-mail-pane-agent'
import { mailDisposition, readMailRow } from './helpers/orchestration-mail-store'

const POINTER_COMMAND = 'orca-dev orchestration check'
const DELIVERY_TIMEOUT_MS = 20_000

type BackgroundWorker = {
  client: RuntimeClient
  userDataDir: string
  worktreeId: string
  handle: string
  agent: MailPaneAgent
}

async function startWorkerInUnopenedWorkspace(
  page: Page,
  electronApp: ElectronApplication
): Promise<BackgroundWorker> {
  await waitForSessionReady(page)
  const activeWorktreeId = await waitForActiveWorktree(page)
  const worktreeId = (await getAllWorktreeIds(page)).find((id) => id !== activeWorktreeId)
  if (!worktreeId) {
    throw new Error('needs the seeded secondary worktree')
  }
  const userDataDir = await electronApp.evaluate(({ app }) => app.getPath('userData'))
  const client = new RuntimeClient(userDataDir, 30_000, null, null)
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        return listed.result.worktrees.some((worktree) => worktree.id === worktreeId)
      },
      { timeout: 60_000, message: 'runtime never registered the secondary worktree' }
    )
    .toBe(true)

  const agent = createMailPaneAgent()
  const created = await client.call<{ terminal: RuntimeTerminalCreate }>('terminal.create', {
    worktree: `id:${worktreeId}`,
    command: agent.launchCommand
  })
  const handle = created.result.terminal.handle
  await expect
    .poll(() => agent.hasStarted(), { timeout: 60_000, message: 'agent never started' })
    .toBe(true)
  return { client, userDataDir, worktreeId, handle, agent }
}

async function readSummary(worker: BackgroundWorker): Promise<RuntimeTerminalSummary | undefined> {
  // A pane mounting the terminal briefly refuses the listing (terminal_surface_ownership_unavailable).
  const listed = await worker.client
    .call<RuntimeTerminalListResult>('terminal.list')
    .catch(() => null)
  return listed?.result.terminals.find((entry) => entry.handle === worker.handle)
}

async function waitForObservedTitle(worker: BackgroundWorker, title: string): Promise<void> {
  await expect
    .poll(async () => (await readSummary(worker))?.title ?? null, {
      timeout: 30_000,
      message: `runtime never observed the title ${title}`
    })
    .toBe(title)
}

test.describe('orchestration across a worker pane remount', () => {
  test('a wait and a mail pointer survive opening the worker workspace', async ({
    orcaPage,
    electronApp
  }) => {
    // Agent launch, a worktree activation, a 60 s wait budget and pointer delivery.
    test.setTimeout(180_000)
    const worker = await startWorkerInUnopenedWorkspace(orcaPage, electronApp)
    worker.agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(worker, CODEX_WORKING_TITLE)
    const run = await worker.client.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Mail across a remount',
      from: worker.handle
    })
    const runId = run.result.run.id
    const sendMail = (subject: string) =>
      worker.client.call<{ message: { id: string } }>('orchestration.send', {
        to: `run:${runId}`,
        from: 'e2e-sender',
        subject,
        body: 'e2e body',
        type: 'status'
      })
    const pointerCount = () => worker.agent.readStdin().split(POINTER_COMMAND).length - 1
    const expectPushed = async (messageId: string, pointersBefore: number) => {
      await expect
        .poll(pointerCount, {
          timeout: DELIVERY_TIMEOUT_MS,
          message: 'mail pointer never reached the worker'
        })
        .toBeGreaterThan(pointersBefore)
      await expect
        .poll(() => mailDisposition(readMailRow(worker.userDataDir, messageId)), {
          timeout: DELIVERY_TIMEOUT_MS
        })
        .toBe('pushed')
    }

    // Mid-turn mail reaches the terminal before its workspace opens.
    const beforeOpen = await sendMail('Mail before the workspace opens')
    await expectPushed(beforeOpen.result.message.id, 0)

    const wait = worker.client.call<{ wait: RuntimeTerminalWait }>(
      'terminal.wait',
      { terminal: worker.handle, for: 'tui-idle', timeoutMs: 60_000 },
      { timeoutMs: 90_000 }
    )
    const settled = wait.then(
      (response) => ({ ok: true as const, wait: response.result.wait }),
      (error: unknown) => ({ ok: false as const, error: String(error) })
    )

    // Opening the workspace mounts a pane for the worker's live terminal.
    await switchToWorktree(orcaPage, worker.worktreeId)
    await expect
      .poll(async () => (await readSummary(worker))?.orphaned, {
        timeout: 30_000,
        message: 'the opened workspace never showed the worker terminal in a pane'
      })
      .toBe(false)

    worker.agent.setTitle(CODEX_IDLE_TITLE)
    const outcome = await settled
    expect(outcome).toMatchObject({ ok: true, wait: { handle: worker.handle, satisfied: true } })
    // The worker keeps its name: the pane that now shows it does not mint a new handle.
    expect(await readSummary(worker)).toMatchObject({ orphaned: false, connected: true })

    // Mail after the remount still reaches the same terminal.
    const pointersBeforeSecond = pointerCount()
    const afterOpen = await sendMail('Mail after the workspace opens')
    await expectPushed(afterOpen.result.message.id, pointersBeforeSecond)
  })
})
