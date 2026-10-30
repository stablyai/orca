// #12536: restart must not inject mail until the agent emits a fresh live title.
// Cold relaunch publishes leaves after restore seeding, so this case restores no status and does not pin lastAgentStatusObservedLive.
// orca-runtime.test.ts stages seeded idle directly to pin that gate; this spec proves the real process survives two launches.
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

const POINTER_COMMAND = 'orca-dev orchestration check'
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

    // Reuse the mounted fixture leaf; terminal.create instead races hidden CI’s 10s renderer graph-sync wait.
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
    const run = await firstClient.call<{ run: { id: string } }>('orchestration.runCreate', {
      objective: 'Restart-safe mailbox delivery',
      from: originalHandle
    })

    await session.close(firstApp)
    firstApp = null

    const second = await session.launch()
    secondApp = second.app
    const secondClient = new RuntimeClient(session.userDataDir, 30_000, null, null)

    // The surviving PTY is identified by process identity; restart may mint a new handle.
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

    // The process emitted nothing after restart, so any status is restored memory rather than live observation.
    expect(agent.titleEmitCount()).toBe(titlesBeforeRestart)

    const sent = await secondClient.call<{ message: { id: string } }>('orchestration.send', {
      to: `run:${run.result.run.id}`,
      from: 'e2e-sender',
      subject: 'Seeded idle must wait',
      body: 'e2e body',
      type: 'status'
    })
    const messageId = sent.result.message.id

    // Wait the full window; polling pending could pass before push runs.
    expect(readMailRow(session.userDataDir, messageId)).toBeDefined()
    await second.page.waitForTimeout(NO_DELIVERY_SETTLE_MS)
    expect(mailDisposition(readMailRow(session.userDataDir, messageId))).toBe('pending')
    expect(agent.readStdin()).not.toContain(POINTER_COMMAND)

    // Repeat the same idle title to change only observation liveness and resume delivery.
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
