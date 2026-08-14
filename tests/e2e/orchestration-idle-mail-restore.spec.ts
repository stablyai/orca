/**
 * Mail must survive a restart: never injected on restored state alone, always
 * pointed once the agent speaks again (#12536).
 *
 * Push-on-idle now fires when mail arrives rather than only on a busy→idle edge,
 * which puts restart squarely on the delivery path — a pane comes back carrying
 * the title it had at snapshot time, and anything the runtime infers from that
 * is a memory, not an observation. Typing on it would submit into an agent that
 * may be mid-turn.
 *
 * The catch that makes waiting insufficient: an idle agent TUI is silent. It
 * paints its title on the working→idle edge and emits nothing after, so a pane
 * restored while its agent sits at the prompt never produces the frame the gate
 * waits for. Mail addressed to it strands until a human gives the agent
 * something to do. So the runtime probes instead — quiescence plus a recognized
 * foreground agent stands in for the title that is never coming.
 *
 * The two tests split on exactly that probe. The first pane runs under a name
 * Orca recognizes as an agent and is delivered to without ever speaking again;
 * the second runs under bare `node`, a wrapper rather than an agent, so the
 * probe refuses it and only a live frame releases the row. Both leaves come
 * back with no agent status at all — the seed reaches only leaves that exist
 * when pty:spawn returns the restore payload, and a cold relaunch publishes its
 * graph after that. The seeded-idle ordering is staged directly in
 * src/main/runtime/orca-runtime.test.ts. What earns this spec its Electron
 * launches is that none of the restart behavior above is reachable from a
 * single-launch spec at all.
 */
import { existsSync, readFileSync } from 'node:fs'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId
} from './helpers/terminal'
import { RuntimeClient } from '../../src/cli/runtime-client'
import type { RuntimeTerminalListResult } from '../../src/shared/runtime-types'
import {
  CODEX_IDLE_TITLE,
  CODEX_WORKING_TITLE,
  createMailPaneAgent
} from './helpers/orchestration-mail-pane-agent'
import { mailDisposition, readMailRow } from './helpers/orchestration-mail-store'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

const POINTER_COMMAND = 'orca orchestration check'
const NO_DELIVERY_SETTLE_MS = 5_000
const DELIVERY_TIMEOUT_MS = 20_000

test.describe.configure({ mode: 'serial' })

async function waitForRegisteredWorktree(client: RuntimeClient, worktreeId: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const listed = await client.call<{ worktrees: { id: string }[] }>('worktree.list', {})
        return listed.result.worktrees.some((worktree) => worktree.id === worktreeId)
      },
      { timeout: 60_000, message: 'runtime never registered the worktree' }
    )
    .toBe(true)
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

test('delivers mail after a restart to a quiet pane whose agent never speaks again', async (// oxlint-disable-next-line no-empty-pattern -- this spec owns both Electron launches and opts out of the shared app fixture.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    const firstClient = new RuntimeClient(session.userDataDir, 30_000, null, null)
    await waitForRegisteredWorktree(firstClient, worktreeId)

    const ptyId = await waitForActivePanePtyId(first.page)
    const { paneKey } = await waitForActivePaneHookDescriptor(first.page)
    const originalHandle = (
      await firstClient.call<{ terminal: { handle: string } }>('terminal.resolvePane', { paneKey })
    ).result.terminal.handle

    await waitForPtyShellEcho(first.page, ptyId, 60_000)
    // Why a recognized process name: an agent Orca cannot name is not something
    // it will submit Enter into, so the quiescence path refuses it by design.
    const agent = createMailPaneAgent({ processName: 'codex' })
    await execInTerminal(first.page, ptyId, agent.launchCommand)
    await expect
      .poll(() => agent.hasStarted(), { timeout: 60_000, message: 'agent never started' })
      .toBe(true)

    agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(firstClient, originalHandle, CODEX_WORKING_TITLE)
    agent.setTitle(CODEX_IDLE_TITLE)
    await waitForObservedTitle(firstClient, originalHandle, CODEX_IDLE_TITLE)
    const titlesBeforeRestart = agent.titleEmitCount()

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    const secondClient = new RuntimeClient(session.userDataDir, 30_000, null, null)

    let restoredHandle: string | null = null
    await expect
      .poll(
        async () => {
          const listed = await secondClient.call<RuntimeTerminalListResult>('terminal.list')
          const restored = listed.result.terminals.find(
            (entry) => entry.ptyId === ptyId && entry.writable
          )
          restoredHandle = restored?.handle ?? null
          return restored?.title ?? null
        },
        { timeout: 120_000, message: 'agent pane never came back writable after restart' }
      )
      .toBe(CODEX_IDLE_TITLE)
    expect(restoredHandle).toBeTruthy()
    expect(agent.titleEmitCount()).toBe(titlesBeforeRestart)

    const sent = await secondClient.call<{ message: { id: string } }>('orchestration.send', {
      to: restoredHandle!,
      from: 'e2e-sender',
      subject: 'Quiet restored agent',
      body: 'e2e body',
      type: 'status'
    })
    const messageId = sent.result.message.id

    // The regression this guards: a real idle agent emits nothing while it
    // waits, so before this fix the pane sat unreachable until a human gave it
    // something to do. No title is set anywhere below — the pointer arriving is
    // the whole point.
    await expect
      .poll(() => agent.readStdin(), {
        timeout: DELIVERY_TIMEOUT_MS,
        message: 'restored quiet agent never received the pointer'
      })
      .toContain(POINTER_COMMAND)
    expect(agent.titleEmitCount()).toBe(titlesBeforeRestart)
    expect(mailDisposition(readMailRow(session.userDataDir, messageId))).toBe('pending')
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

test('keeps mail pending across a restart and delivers it when the agent reports live', async (// oxlint-disable-next-line no-empty-pattern -- this spec owns both Electron launches and opts out of the shared app fixture.
{}, testInfo) => {
  test.setTimeout(300_000)
  const repoPath = existsSync(TEST_REPO_PATH_FILE)
    ? readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    : ''
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const first = await session.launch()
    firstApp = first.app
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    const firstClient = new RuntimeClient(session.userDataDir, 30_000, null, null)
    await waitForRegisteredWorktree(firstClient, worktreeId)

    // The pane attachRepoAndOpenTerminal already opened is mounted, so its leaf
    // exists; terminal.create would instead race a 10s renderer graph-sync wait
    // that a headless CI renderer loses.
    const ptyId = await waitForActivePanePtyId(first.page)
    const { paneKey } = await waitForActivePaneHookDescriptor(first.page)
    const originalHandle = (
      await firstClient.call<{ terminal: { handle: string } }>('terminal.resolvePane', { paneKey })
    ).result.terminal.handle
    const originalPtyId = ptyId

    // Keystrokes typed before the shell reaches its prompt are dropped outright.
    await waitForPtyShellEcho(first.page, ptyId, 60_000)
    const agent = createMailPaneAgent()
    await execInTerminal(first.page, ptyId, agent.launchCommand)
    await expect
      .poll(() => agent.hasStarted(), { timeout: 60_000, message: 'agent never started' })
      .toBe(true)

    agent.setTitle(CODEX_WORKING_TITLE)
    await waitForObservedTitle(firstClient, originalHandle, CODEX_WORKING_TITLE)
    agent.setTitle(CODEX_IDLE_TITLE)
    await waitForObservedTitle(firstClient, originalHandle, CODEX_IDLE_TITLE)
    const titlesBeforeRestart = agent.titleEmitCount()

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    const secondClient = new RuntimeClient(session.userDataDir, 30_000, null, null)

    // The PTY outlives the app, so the restored pane is found by process
    // identity; its handle may or may not be the one the first launch minted.
    let restoredHandle: string | null = null
    await expect
      .poll(
        async () => {
          const listed = await secondClient.call<RuntimeTerminalListResult>('terminal.list')
          const restored = listed.result.terminals.find(
            (entry) => entry.ptyId === originalPtyId && entry.writable
          )
          restoredHandle = restored?.handle ?? null
          return restored?.title ?? null
        },
        { timeout: 120_000, message: 'agent pane never came back writable after restart' }
      )
      .toBe(CODEX_IDLE_TITLE)
    expect(restoredHandle).toBeTruthy()

    // The process has emitted nothing since the restart, so whatever the runtime
    // believes about this pane's status came back with the graph, not from it.
    expect(agent.titleEmitCount()).toBe(titlesBeforeRestart)

    const sent = await secondClient.call<{ message: { id: string } }>('orchestration.send', {
      to: restoredHandle!,
      from: 'e2e-sender',
      subject: 'Seeded idle must wait',
      body: 'e2e body',
      type: 'status'
    })
    const messageId = sent.result.message.id

    // Why a fixed wait: expect.poll would settle on the first 'pending' reading,
    // before the push had any chance to run, and assert nothing.
    expect(readMailRow(session.userDataDir, messageId)).toBeDefined()
    await second.page.waitForTimeout(NO_DELIVERY_SETTLE_MS)
    expect(mailDisposition(readMailRow(session.userDataDir, messageId))).toBe('pending')
    expect(agent.readStdin()).not.toContain(POINTER_COMMAND)

    // Re-emitting the SAME idle title changes no status — only its liveness — so
    // the pointer appearing here is delivery resuming on the agent's own signal.
    agent.setTitle(CODEX_IDLE_TITLE)
    await expect
      .poll(() => agent.titleEmitCount(), { timeout: 30_000 })
      .toBeGreaterThan(titlesBeforeRestart)
    await expect
      .poll(() => agent.readStdin(), {
        timeout: DELIVERY_TIMEOUT_MS,
        message: 'live idle frame never released the pending mail'
      })
      .toContain(POINTER_COMMAND)
    expect(mailDisposition(readMailRow(session.userDataDir, messageId))).toBe('pending')
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
