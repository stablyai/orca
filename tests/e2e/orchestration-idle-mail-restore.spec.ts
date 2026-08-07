/**
 * Mail must survive a restart: never injected on restored state alone, always
 * delivered once the agent speaks again (#12536).
 *
 * Push-on-idle now fires when mail arrives rather than only on a busy→idle edge,
 * which puts restart squarely on the delivery path — a pane comes back carrying
 * the title it had at snapshot time, and anything the runtime infers from that
 * is a memory, not an observation. Typing on it would submit into an agent that
 * may be mid-turn and stamp the row delivered, losing it.
 *
 * Scope, stated plainly: this covers the restart path, not the
 * `lastAgentStatusObservedLive` gate itself. The seed only reaches leaves that
 * already exist when pty:spawn returns the restore payload, and a cold relaunch
 * publishes its graph after that — so the leaf here comes back with no agent
 * status rather than a seeded idle, and this spec passes with the gate removed.
 * The gate is pinned in src/main/runtime/orca-runtime.test.ts
 * ('does not push on a cold-restore seeded idle status with no live
 * observation'), which can stage that ordering directly. What earns this spec
 * its two Electron launches is that neither half of the restart behavior above
 * is reachable from a single-launch spec at all.
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

const BANNER_PREFIX = '--- Orchestration Messages'
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
    expect(agent.readStdin()).not.toContain(BANNER_PREFIX)

    // Re-emitting the SAME idle title changes no status — only its liveness — so
    // the row moving here is delivery resuming on the agent's own signal.
    agent.setTitle(CODEX_IDLE_TITLE)
    await expect
      .poll(() => agent.titleEmitCount(), { timeout: 30_000 })
      .toBeGreaterThan(titlesBeforeRestart)
    await expect
      .poll(() => agent.readStdin(), {
        timeout: DELIVERY_TIMEOUT_MS,
        message: 'live idle frame never released the pending mail'
      })
      .toContain(BANNER_PREFIX)
    await expect
      .poll(() => mailDisposition(readMailRow(session.userDataDir, messageId)), {
        timeout: DELIVERY_TIMEOUT_MS
      })
      .toBe('pushed')
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
