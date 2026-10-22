/**
 * After a relaunch, a workspace's sleeping agents resume only when the user can see them.
 *
 * Every agent's PTY dies while Orca is closed (the daemon is killed, as a reboot would), so each
 * agent tab holds a resumable record and no live session. Opening the workspace must resume the
 * agents in the panes on screen; every other tab resumes when the user switches to it, and a
 * phone opening the workspace still wakes them immediately.
 *
 * Run:
 *   pnpm exec playwright test tests/e2e/relaunch-sleeping-agents-resume-on-view.spec.ts \
 *     --config tests/playwright.config.ts --project electron-headless --workers=1
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { mutateStoppedProfileState } from './helpers/persisted-profile-state'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneCount
} from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { createHostRendererTerminalTab } from './helpers/host-created-terminal-retention-oracle'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

// Long enough for every mounted pane's restore to have started on a build that resumes eagerly.
const SETTLE_MS = 8_000

type AgentPane = { tabId: string; paneKey: string; sessionId: string }

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

/** An agent CLI stand-in that records each resume it is asked for, then stays running. */
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

/** Panes whose agent was resumed, in seeding order; the fake agent logs its pane's key. */
function resumedPanes(log: string, panes: readonly AgentPane[]): string[] {
  const resumed = new Set(readFileSync(log, 'utf8').split('\n'))
  return panes.filter((pane) => resumed.has(pane.paneKey)).map((pane) => pane.paneKey)
}

async function readPaneKeys(page: Page, tabId: string): Promise<string[]> {
  return page.evaluate((id) => {
    const root = window.__store?.getState().terminalLayoutsByTabId[id]?.root ?? null
    const leaves: string[] = []
    const walk = (node: typeof root): void => {
      if (!node) {
        return
      }
      if (node.type === 'leaf') {
        leaves.push(`${id}:${node.leafId}`)
        return
      }
      walk(node.first)
      walk(node.second)
    }
    walk(root)
    return leaves
  }, tabId)
}

async function reportWorkingAgent(page: Page, worktreeId: string, pane: AgentPane): Promise<void> {
  await page.evaluate(
    ({ paneKey, worktreeId: wtId, sessionId }) => {
      window.__store
        ?.getState()
        .setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'finish the task', agentType: 'codex' },
          'Codex',
          undefined,
          { worktreeId: wtId },
          { providerSession: { key: 'session_id', id: sessionId } }
        )
    },
    { paneKey: pane.paneKey, worktreeId, sessionId: pane.sessionId }
  )
}

function pointRecordsAtFakeAgent(userDataDir: string, command: string, count: number): void {
  mutateStoppedProfileState(userDataDir, (state) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test owns the persisted fixture; optional fields are checked at use sites.
    const data = state as {
      workspaceSession?: {
        sleepingAgentSessionsByPaneKey?: Record<string, { launchConfig?: unknown }>
      }
    }
    const records = Object.values(data.workspaceSession?.sleepingAgentSessionsByPaneKey ?? {})
    if (records.length !== count) {
      throw new Error(`Expected ${count} persisted agent records, found ${records.length}`)
    }
    for (const record of records) {
      record.launchConfig = { agentCommand: command, agentArgs: '', agentEnv: {} }
    }
  })
}

async function activateTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store?.getState()
    store?.setActiveTab(id)
    store?.setActiveTabType('terminal', store.activeWorktreeId)
  }, tabId)
}

/** Moves the tab through the window's own tab-move path, which a layout-owner build sends to main. */
async function moveTabIntoRightGroup(
  app: ElectronApplication,
  page: Page,
  worktreeId: string,
  anchorTabId: string,
  movedTabId: string
): Promise<void> {
  const move = await page.evaluate(
    ({ wtId, anchorTabId, movedTabId }) => {
      const tabs = window.__store!.getState().unifiedTabsByWorktree[wtId] ?? []
      const anchor = tabs.find((tab) => tab.entityId === anchorTabId)
      const moved = tabs.find((tab) => tab.entityId === movedTabId)
      if (!anchor || !moved) {
        throw new Error('Could not find the tabs to place side by side')
      }
      return { tabId: moved.id, targetGroupId: anchor.groupId }
    },
    { wtId: worktreeId, anchorTabId, movedTabId }
  )
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ui:moveSessionTab', payload)
    },
    { worktreeId, kind: 'split' as const, splitDirection: 'right' as const, ...move }
  )
  await expect
    .poll(() =>
      page.evaluate(
        (wtId) => window.__store?.getState().groupsByWorktree[wtId]?.length ?? 0,
        worktreeId
      )
    )
    .toBe(2)
}

type Scenario = {
  app: ElectronApplication
  page: Page
  worktreeId: string
  log: string
}

/**
 * Opens `tabCount` terminal tabs (the first split in two when `splitFirstTab`; the second moved
 * into a side-by-side group when `secondTabInRightGroup`), reports a working agent in every
 * pane, quits with the first tab on screen, kills the daemon, and relaunches.
 */
async function relaunchWithSleepingAgents(
  testInfo: Parameters<Parameters<typeof test>[2]>[1],
  options: { tabCount: number; splitFirstTab?: boolean; secondTabInRightGroup?: boolean },
  run: (scenario: Scenario, panes: AgentPane[]) => Promise<void>
): Promise<void> {
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }
  test.skip(process.platform === 'win32', 'Uses POSIX SIGKILL and a shell-script agent')

  const fakeAgent = writeFakeAgent(testInfo.outputPath())
  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null
  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const page = await firstApp.firstWindow()
    const worktreeId = await attachRepoAndOpenTerminal(page, repoPath)
    await waitForSessionReady(page)
    await waitForActiveWorktree(page)
    await ensureTerminalVisible(page)
    await waitForActiveTerminalManager(page, 30_000)
    await waitForPaneCount(page, 1, 30_000)

    const firstTabId = await page.evaluate(
      (wtId) => window.__store?.getState().tabsByWorktree[wtId]?.[0]?.id ?? null,
      worktreeId
    )
    if (!firstTabId) {
      throw new Error('The workspace never opened its first terminal tab')
    }
    if (options.splitFirstTab) {
      await splitActiveTerminalPane(page, 'vertical')
      await waitForPaneCount(page, 2, 30_000)
    }
    const tabIds = [firstTabId]
    for (let index = 1; index < options.tabCount; index += 1) {
      tabIds.push(await createHostRendererTerminalTab(page, worktreeId))
    }

    const panes: AgentPane[] = []
    for (const tabId of tabIds) {
      for (const paneKey of await readPaneKeys(page, tabId)) {
        const pane = { tabId, paneKey, sessionId: `e2e-lazy-resume-${panes.length}-${Date.now()}` }
        session.seedCodexResumeRollout(pane.sessionId, repoPath)
        await reportWorkingAgent(page, worktreeId, pane)
        panes.push(pane)
      }
    }
    if (options.secondTabInRightGroup) {
      await moveTabIntoRightGroup(firstApp, page, worktreeId, tabIds[0]!, tabIds[1]!)
    }
    await activateTab(page, firstTabId)

    const daemonPid = readDaemonPid(session.userDataDir)
    await session.close(firstApp)
    firstApp = null
    pointRecordsAtFakeAgent(session.userDataDir, fakeAgent.command, panes.length)
    // Why: every agent dies with the daemon while Orca is closed, as on a reboot.
    process.kill(daemonPid, 'SIGKILL')

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    await expect
      .poll(() => secondLaunch.page.evaluate(() => window.__store?.getState().activeWorktreeId), {
        timeout: 15_000
      })
      .toBe(worktreeId)
    await ensureTerminalVisible(secondLaunch.page)
    await run({ app: secondApp, page: secondLaunch.page, worktreeId, log: fakeAgent.log }, panes)
  } finally {
    if (secondApp) {
      await session.close(secondApp)
    }
    if (firstApp) {
      await session.close(firstApp)
    }
    await session.dispose()
  }
}

test('resumes only the visible sleeping agent, then each tab as it is opened, and all on a phone wake', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  await relaunchWithSleepingAgents(
    testInfo,
    { tabCount: 3 },
    async ({ app, page, worktreeId, log }, panes) => {
      const [visible, second, third] = panes
      await expect
        .poll(() => resumedPanes(log, panes), { timeout: 30_000 })
        .toContain(visible!.paneKey)
      await page.waitForTimeout(SETTLE_MS)
      expect(resumedPanes(log, panes), 'hidden tabs resumed on workspace open').toEqual([
        visible!.paneKey
      ])

      await activateTab(page, second!.tabId)
      await expect
        .poll(() => resumedPanes(log, panes), { timeout: 30_000 })
        .toEqual([visible!.paneKey, second!.paneKey])
      await page.waitForTimeout(SETTLE_MS / 2)
      expect(resumedPanes(log, panes)).toEqual([visible!.paneKey, second!.paneKey])

      // A phone opening the workspace wakes the rest without the user opening the tab.
      await app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('ui:resumeSleepingAgents', {
          worktreeId: id
        })
      }, worktreeId)
      await expect
        .poll(() => resumedPanes(log, panes), { timeout: 30_000 })
        .toEqual([visible!.paneKey, second!.paneKey, third!.paneKey])
    }
  )
})

test('resumes both agents of a visible split and none in hidden tabs', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  await relaunchWithSleepingAgents(
    testInfo,
    { tabCount: 2, splitFirstTab: true },
    async ({ log }, panes) => {
      const splitPanes = panes.filter((pane) => pane.tabId === panes[0]!.tabId)
      expect(splitPanes).toHaveLength(2)
      await expect
        .poll(() => resumedPanes(log, panes), { timeout: 30_000 })
        .toEqual(splitPanes.map((pane) => pane.paneKey))
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
      expect(resumedPanes(log, panes), 'a hidden tab resumed on workspace open').toEqual(
        splitPanes.map((pane) => pane.paneKey)
      )
    }
  )
})

test('resumes the visible tab of each side-by-side group and none behind them', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  await relaunchWithSleepingAgents(
    testInfo,
    { tabCount: 3, secondTabInRightGroup: true },
    async ({ page, log }, panes) => {
      const [leftVisible, rightVisible] = panes
      await expect
        .poll(() => resumedPanes(log, panes), { timeout: 30_000 })
        .toEqual([leftVisible!.paneKey, rightVisible!.paneKey])
      await page.waitForTimeout(SETTLE_MS)
      expect(resumedPanes(log, panes), 'a tab behind a group resumed on open').toEqual([
        leftVisible!.paneKey,
        rightVisible!.paneKey
      ])
    }
  )
})
