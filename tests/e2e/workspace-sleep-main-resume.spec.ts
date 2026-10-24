/**
 * A workspace sleep's agents are resumed by main alone, with the window open: opening a slept
 * pane asks main to resume it, the pane attaches to main's terminal, and each agent resumes once
 * in its own pane, never in a fresh tab.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/workspace-sleep-main-resume.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createHostRendererTerminalTab } from './helpers/host-created-terminal-retention-oracle'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

const SETTLE_MS = 6_000

function readDaemonPid(userDataDir: string): number {
  const raw = readFileSync(
    path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`),
    'utf8'
  )
  const parsed: unknown = JSON.parse(raw)
  const pid = parsed && typeof parsed === 'object' && 'pid' in parsed ? parsed.pid : undefined
  if (typeof pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${raw}`)
  }
  return pid
}

/** An agent CLI stand-in that logs each resume it is asked for, then stays running. */
function writeFakeAgent(dir: string): { command: string; log: string } {
  const command = path.join(dir, 'fake-agent.sh')
  const log = path.join(dir, 'fake-agent-resumes.log')
  writeFileSync(log, '')
  writeFileSync(
    command,
    `#!/bin/sh\nprintf '%s\\n' "$ORCA_PANE_KEY" >> '${log}'\nexec sleep 3600\n`
  )
  chmodSync(command, 0o755)
  return { command, log }
}

/** How many times each pane's agent was resumed. */
function resumeCounts(log: string): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const line of readFileSync(log, 'utf8').split('\n')) {
    if (line) {
      counts[line] = (counts[line] ?? 0) + 1
    }
  }
  return counts
}

async function firstPaneKey(page: Page, tabId: string): Promise<string> {
  const leafId = await page.evaluate((id) => {
    const root = window.__store?.getState().terminalLayoutsByTabId[id]?.root
    return root?.type === 'leaf' ? root.leafId : null
  }, tabId)
  if (!leafId) {
    throw new Error(`Tab ${tabId} has no single leaf`)
  }
  return `${tabId}:${leafId}`
}

test('main resumes each slept pane once, in place, and the window attaches', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  test.skip(!repoPath || !existsSync(repoPath), 'Global setup did not produce a seeded test repo')
  test.skip(process.platform === 'win32', 'Uses POSIX SIGKILL and a shell-script agent')

  const fakeAgent = writeFakeAgent(testInfo.outputPath())
  const session = createRestartSession(testInfo)
  const first = await session.launch()
  let app = first.app
  try {
    const worktreeId = await attachRepoAndOpenTerminal(first.page, repoPath)
    await waitForSessionReady(first.page)
    await waitForActiveWorktree(first.page)
    await ensureTerminalVisible(first.page)
    await waitForActiveTerminalManager(first.page, 30_000)
    await waitForPaneCount(first.page, 1, 30_000)
    const tabIds = await first.page.evaluate(
      (wtId) => (window.__store?.getState().tabsByWorktree[wtId] ?? []).map((tab) => tab.id),
      worktreeId
    )
    tabIds.push(await createHostRendererTerminalTab(first.page, worktreeId))
    await first.page.evaluate((id) => window.__store?.getState().setActiveTab(id), tabIds[0]!)
    const paneKeys = [
      await firstPaneKey(first.page, tabIds[0]!),
      await firstPaneKey(first.page, tabIds[1]!)
    ]
    const daemonPid = readDaemonPid(session.userDataDir)
    await session.close(app)

    // The records a workspace sleep in main leaves: pane-owned, resumed when the tab opens.
    mutateStoppedProfileState(session.userDataDir, (state) => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test owns the persisted fixture.
      const data = state as { workspaceSession?: { sleepingAgentSessionsByPaneKey?: unknown } }
      data.workspaceSession ??= {}
      data.workspaceSession.sleepingAgentSessionsByPaneKey = Object.fromEntries(
        paneKeys.map((paneKey, index) => {
          const sessionId = `e2e-main-resume-${index}-${Date.now()}`
          session.seedCodexResumeRollout(sessionId, repoPath)
          return [
            paneKey,
            {
              paneKey,
              tabId: paneKey.split(':')[0],
              worktreeId,
              agent: 'codex',
              providerSession: { key: 'session_id', id: sessionId },
              prompt: 'finish the task',
              state: 'done',
              capturedAt: Date.now(),
              updatedAt: Date.now(),
              origin: 'worktree-sleep',
              restoreOnTabOpenOnly: true,
              launchConfig: { agentCommand: fakeAgent.command, agentArgs: '', agentEnv: {} }
            }
          ]
        })
      )
    })
    process.kill(daemonPid, 'SIGKILL')

    const second = await session.launch()
    app = second.app
    const page = second.page
    await waitForSessionReady(page)
    await ensureTerminalVisible(page)

    await expect
      .poll(() => resumeCounts(fakeAgent.log), { timeout: 30_000 })
      .toEqual({
        [paneKeys[0]!]: 1
      })
    await page.waitForTimeout(SETTLE_MS)
    expect(resumeCounts(fakeAgent.log), 'a hidden tab resumed, or one resumed twice').toEqual({
      [paneKeys[0]!]: 1
    })

    await page.evaluate((id) => window.__store?.getState().setActiveTab(id), tabIds[1]!)
    await expect
      .poll(() => resumeCounts(fakeAgent.log), { timeout: 30_000 })
      .toEqual({
        [paneKeys[0]!]: 1,
        [paneKeys[1]!]: 1
      })
    await page.waitForTimeout(SETTLE_MS / 2)
    const after = await page.evaluate(
      ({ wtId, ids }) => {
        const state = window.__store!.getState()
        return {
          tabCount: (state.tabsByWorktree[wtId] ?? []).length,
          bound: ids.map((id) => (state.ptyIdsByTabId[id] ?? []).length > 0)
        }
      },
      { wtId: worktreeId, ids: tabIds }
    )
    // In place: no fresh tab, and each pane is bound to the terminal main started.
    expect(after).toEqual({ tabCount: tabIds.length, bound: [true, true] })
    expect(resumeCounts(fakeAgent.log)).toEqual({ [paneKeys[0]!]: 1, [paneKeys[1]!]: 1 })
    // Main keeps its own records; a window that resumed from its copy would have saved them away.
    await page.waitForTimeout(2_000)
    const mainRecords = await page.evaluate(async () =>
      Object.keys((await window.api.session.get()).sleepingAgentSessionsByPaneKey ?? {})
    )
    expect(mainRecords.sort()).toEqual([...paneKeys].sort())
  } finally {
    await session.close(app)
    await session.dispose()
  }
})
