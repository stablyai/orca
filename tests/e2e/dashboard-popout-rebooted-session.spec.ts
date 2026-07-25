import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import {
  discoverActivePtyId,
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  ensureTerminalVisible,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { PROTOCOL_VERSION } from '../../src/main/daemon/types'

/** Tab session ids as they currently sit on disk, across whichever profile the app chose. */
function persistedTabPtyIds(userDataDir: string): string[] {
  const candidates = [
    path.join(userDataDir, 'orca-data.json'),
    ...(existsSync(path.join(userDataDir, 'profiles'))
      ? readdirSync(path.join(userDataDir, 'profiles')).map((profile) =>
          path.join(userDataDir, 'profiles', profile, 'orca-data.json')
        )
      : [])
  ]
  const ptyIds: string[] = []
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue
    }
    let parsed: { workspaceSession?: { tabsByWorktree?: Record<string, { ptyId?: string }[]> } }
    try {
      parsed = JSON.parse(readFileSync(candidate, 'utf8'))
    } catch {
      continue
    }
    for (const tabs of Object.values(parsed.workspaceSession?.tabsByWorktree ?? {})) {
      for (const tab of tabs) {
        if (tab.ptyId) {
          ptyIds.push(tab.ptyId)
        }
      }
    }
  }
  return ptyIds
}

function readDaemonPid(userDataDir: string): number {
  const pidPath = path.join(userDataDir, 'daemon', `daemon-v${PROTOCOL_VERSION}.pid`)
  const parsed = JSON.parse(readFileSync(pidPath, 'utf8')) as { pid?: unknown }
  if (typeof parsed.pid !== 'number') {
    throw new Error(`Daemon pid file did not contain a numeric pid: ${pidPath}`)
  }
  return parsed.pid
}

type RestoredPane = {
  repoId: string
  worktreeId: string
  worktreeName: string
  repoName: string
  tabId: string
  leafId: string
  advertisedPtyId: string | null
}

async function readRestoredPane(page: Page, worktreeId: string): Promise<RestoredPane> {
  const pane = await page.evaluate((worktreeId) => {
    const state = window.__store!.getState()
    const tab = (state.tabsByWorktree[worktreeId] ?? [])[0]
    if (!tab) {
      return null
    }
    const layout = state.terminalLayoutsByTabId[tab.id]
    const leafId = layout?.activeLeafId ?? null
    const repo = state.repos.find((entry) => entry.id === tab.worktreeId.split('::')[0])
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === worktreeId)
    return {
      repoId: repo?.id ?? '',
      worktreeId,
      worktreeName: worktree?.displayName ?? 'worktree',
      repoName: repo?.displayName ?? 'repo',
      tabId: tab.id,
      leafId: leafId ?? '',
      advertisedPtyId: (state.ptyIdsByTabId[tab.id] ?? [])[0] ?? null
    }
  }, worktreeId)
  if (!pane?.leafId) {
    throw new Error('Restored pane had no terminal layout leaf')
  }
  return pane
}

/** Seed the agent-status entry an agent hook would have written for this pane,
 *  so the real snapshot builder — not the test — produces the card. */
async function seedAgentStatus(page: Page, pane: RestoredPane): Promise<void> {
  await page.evaluate((pane) => {
    const paneKey = `${pane.tabId}:${pane.leafId}`
    const now = Date.now()
    window.__store!.setState({
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          state: 'idle',
          prompt: 'Reproduce the rebooted-pane dashboard state',
          updatedAt: now,
          stateStartedAt: now,
          stateHistory: [],
          agentType: 'codex',
          terminalTitle: 'codex',
          lastAssistantMessage: 'Left this running before the reboot.'
        }
      }
    })
  }, pane)
}

async function openPopoutWindow(app: ElectronApplication, page: Page): Promise<Page> {
  await page.evaluate(() =>
    (
      window as unknown as {
        __store: { getState: () => { updateSettings: (patch: unknown) => void } }
      }
    ).__store
      .getState()
      .updateSettings({ experimentalAgentDashboardPopout: true })
  )
  await page.evaluate(() => window.api.dashboard.openPopout())
  return await app.waitForEvent('window', { timeout: 30_000 })
}

test.describe.configure({ mode: 'serial' })

// Why: the daemon dies with the machine, so after a reboot every restored pane
// names a session that no longer exists. The board used to report all of them
// as closed; it must replay the last saved frame instead, read-only.
test('pop-out dashboard replays a rebooted pane from history', async (// oxlint-disable-next-line no-empty-pattern -- Playwright's second fixture arg is testInfo; the first must be an object destructure to opt out of the default fixture set.
{}, testInfo) => {
  // Two full Electron cold starts plus a daemon kill; the 120s default is not
  // enough on CI. Matches what the other restart-restore specs allow.
  test.setTimeout(300_000)
  const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf-8').trim()
  if (!repoPath || !existsSync(repoPath)) {
    test.skip(true, 'Global setup did not produce a seeded test repo')
    return
  }

  const session = createRestartSession(testInfo)
  let firstApp: ElectronApplication | null = null
  let secondApp: ElectronApplication | null = null

  try {
    const firstLaunch = await session.launch()
    firstApp = firstLaunch.app
    const worktreeId = await attachRepoAndOpenTerminal(firstLaunch.page, repoPath)
    await waitForSessionReady(firstLaunch.page)
    await waitForActiveWorktree(firstLaunch.page)
    await ensureTerminalVisible(firstLaunch.page)
    await waitForActiveTerminalManager(firstLaunch.page, 30_000)
    await waitForPaneCount(firstLaunch.page, 1, 30_000)

    const ptyId = await discoverActivePtyId(firstLaunch.page)
    const marker = `REBOOTED_PANE_${Date.now()}`
    await execInTerminal(firstLaunch.page, ptyId, `echo ${marker}`)
    await waitForTerminalOutput(firstLaunch.page, marker)

    // The session writer is debounced and the next launch restores from disk,
    // not memory — wait for this pane to actually land there.
    await expect
      .poll(() => persistedTabPtyIds(session.userDataDir), { timeout: 30_000 })
      .toContain(ptyId)

    // Why switch away: the next launch remounts the ACTIVE worktree's pane,
    // which respawns its PTY and makes the preview live again. The reported bug
    // is about every other worktree — restored, advertised as live, never
    // mounted. Park this one in the background so it stays that way.
    const otherWorktreeId = (await getAllWorktreeIds(firstLaunch.page)).find(
      (id) => id !== worktreeId
    )
    if (!otherWorktreeId) {
      throw new Error('Seeded repo did not expose a second worktree to park on')
    }
    await switchToWorktree(firstLaunch.page, otherWorktreeId)

    // Quit leaves meta.endedAt null (the session stays crash-recoverable), then
    // SIGKILL stands in for the reboot that takes the daemon with it.
    const daemonPid = readDaemonPid(session.userDataDir)
    await session.close(firstApp)
    firstApp = null
    process.kill(daemonPid, 'SIGKILL')

    const secondLaunch = await session.launch()
    secondApp = secondLaunch.app
    await waitForSessionReady(secondLaunch.page)
    await waitForActiveWorktree(secondLaunch.page)

    // The restored tab still advertises its pre-reboot ptyId even though the
    // daemon that owned it is gone — the condition that made every card report
    // "pane has closed".
    const restored = await readRestoredPane(secondLaunch.page, worktreeId)
    expect(restored.advertisedPtyId).toBe(ptyId)

    const popout = await openPopoutWindow(secondApp, secondLaunch.page)
    // Why seed rather than drive a real agent: the board lists agents, and cold
    // start drops runtime pane titles, so a shell mints no card. Only the hook
    // status is seeded — the snapshot builder, the dialog, terminalPreview's
    // history lookup and the frame itself all stay real.
    await seedAgentStatus(secondLaunch.page, restored)

    const card = popout.locator('button').first()
    await card.click({ timeout: 30_000 })

    const dialog = popout.locator('[role="dialog"]')
    await expect(dialog).toBeVisible({ timeout: 30_000 })
    // The pane is gone, but its last frame is not.
    await expect(dialog.getByText(/last saved frame/)).toBeVisible({ timeout: 30_000 })
    await expect(dialog).toContainText(marker, { timeout: 30_000 })

    await popout.screenshot({
      path: testInfo.outputPath('dashboard-popout-history-frame.png'),
      // Why: the dialog's fade-in would otherwise be captured half-transparent.
      animations: 'disabled'
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
